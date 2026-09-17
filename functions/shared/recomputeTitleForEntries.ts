// Purpose: The shared per-parent recompute loop used by every dispatch
// branch. Given a list of candidate entries, skip those not bound to this
// app, run the editor-side `composition` against each, and PATCH the title
// field (idempotent when the new title matches). Per-entry failures are
// logged and swallowed so one bad entry can't block the rest of the batch.

import type { EntryProps, PlainClientAPI } from "contentful-management";
import { composition } from "../../src/fragments";
import { composeTitle } from "../../src/fragments/compose";
import type { ConceptReader } from "../../src/fragments/types";
import { createManagedTitleFieldLookup } from "./findManagedTitleFieldId";

type Args = {
  cma: PlainClientAPI;
  environmentId: string;
  defaultLocale: string;
  entries: EntryProps[];
  // Used in error logs to identify which propagation flow surfaced the failure.
  context: string;
  // Taxonomy reads for the `conceptNotation` fragment. Optional only so the
  // type doesn't force every caller to construct one, but EVERY dispatch branch
  // must pass it: without it that fragment reports an unknown value, which now
  // makes this loop SKIP the entry rather than rewrite its title without the
  // notation. Titles then silently stop being maintained, so the warning it logs
  // is the signal to look for.
  conceptReader?: ConceptReader;
  // Forwarded to `publicationDate`. Set it only from the Release.* /
  // ScheduledAction.* branch, where the event proves a schedule exists and an
  // empty read means "not queryable yet". The publish fan-out must leave it
  // unset — retrying there costs 5 CMA requests per unscheduled entry and
  // buys nothing. See SCHEDULE_LOOKUP_RETRY_DELAYS_MS.
  awaitScheduleConsistency?: boolean;
};

// Shared per-parent recompute loop used by both the regionTitle and releaseDate
// dispatch branches. For each parent:
//   - skip if its title field isn't bound to this app
//   - recompute via composeTitle
//   - skip if the new title matches the current title (idempotency)
//   - otherwise patch the entry as a draft
// Per-parent failures are logged and skipped so one bad entry doesn't block
// the rest.
export const recomputeTitleForEntries = async ({
  cma,
  environmentId,
  defaultLocale,
  entries,
  context,
  conceptReader,
  awaitScheduleConsistency,
}: Args): Promise<void> => {
  // One lookup per content type for this whole batch, not one per entry — see
  // the comment on `createManagedTitleFieldLookup`. Built here so its lifetime
  // is exactly this call.
  const managedTitleFieldFor = createManagedTitleFieldLookup(cma);

  for (const parent of entries) {
    try {
      const titleFieldId = await managedTitleFieldFor(parent);
      if (!titleFieldId) continue;

      const newTitle = await composeTitle(composition, {
        entry: parent,
        cma,
        defaultLocale,
        environmentId,
        conceptReader,
        awaitScheduleConsistency,
      });
      // `null` = some fragment couldn't determine its contribution (in practice
      // a taxonomy read that didn't happen). PATCHing the shortened title would
      // delete the real one, and this loop runs across a whole fan-out, so one
      // missing delivery key would strip every entry it touched. Skip instead —
      // the fragment has already warned about why.
      if (newTitle === null) continue;

      const currentTitle = parent.fields[titleFieldId]?.[defaultLocale];
      if (newTitle === currentTitle) continue;

      // `entry.patch` (JSON Patch) is the documented canonical pattern for
      // single-field mutations from a Function — partial-update avoids
      // accidentally dropping fields the function doesn't know about, and
      // takes an explicit version arg for optimistic locking.
      const titleField = parent.fields[titleFieldId];
      const ops = titleField
        ? [
            {
              op: "add" as const,
              path: `/fields/${titleFieldId}/${defaultLocale}`,
              value: newTitle,
            },
          ]
        : [
            {
              op: "add" as const,
              path: `/fields/${titleFieldId}`,
              value: { [defaultLocale]: newTitle },
            },
          ];

      await cma.entry.patch(
        { entryId: parent.sys.id, version: parent.sys.version },
        ops,
      );
    } catch (err) {
      console.warn(
        `[auto-entry-title] ${context}: failed to propagate title for entry "${parent.sys.id}".`,
        err,
      );
    }
  }
};
