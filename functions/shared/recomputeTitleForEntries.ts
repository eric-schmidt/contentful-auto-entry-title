// Purpose: The shared per-parent recompute loop used by every dispatch
// branch. Given a list of candidate entries, skip those not bound to this
// app, run the editor-side `composition` against each, and PATCH the title
// field (idempotent when the new title matches). Per-entry failures are
// logged and swallowed so one bad entry can't block the rest of the batch.
//
// Rate limiting: entries run through `mapWithConcurrency` and each PATCH through
// `withRateLimitRetry`, because neither `context.cma` nor `sdk.cma` carries the
// SDK's own 429 retry — both are `apiAdapter` clients, which bypass the axios
// interceptor that implements it. See ./rateLimit.ts for the full reasoning.
//
// What this does NOT fix: a Function is killed at 30s with no retry, so a few
// hundred entries still truncate mid-batch. Concurrency raises throughput and
// retry only costs time when actually limited, but the real fix for truncation
// is the resumable skip/limit batching in
// plans/recompute-concept-titles-ui-and-bulk-writes.md.

import type { EntryProps, PlainClientAPI } from "contentful-management";
import { composition } from "../../src/fragments";
import { composeTitle } from "../../src/fragments/compose";
import type { ConceptReader } from "../../src/fragments/types";
import { createManagedTitleFieldLookup } from "./findManagedTitleFieldId";
import { mapWithConcurrency, withRateLimitRetry } from "./rateLimit";

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

// Per-entry outcome counts. Returned because every per-entry failure is
// swallowed with a `console.warn`, so without this a caller (in particular the
// App Action, which reports back to a user) cannot tell a clean run from one
// that failed on every single entry.
export type RecomputeCounts = {
  considered: number;
  updated: number;
  // Deliberately not bound to this app, title already correct, or a fragment
  // declined to contribute — all normal, none an error.
  skipped: number;
  failed: number;
};

// Low on purpose: each entry ALSO spends fragment reads (a `cma.entry.get` per
// reference, plus scheduled-action lookups), so effective requests/second is a
// multiple of this against a ~7 req/s cap.
const PATCH_CONCURRENCY = 3;

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
}: Args): Promise<RecomputeCounts> => {
  // One lookup per content type for this whole batch, not one per entry — see
  // the comment on `createManagedTitleFieldLookup`. Built here so its lifetime
  // is exactly this call. It caches the in-flight PROMISE, so concurrent
  // workers hitting the same content type share one request rather than racing.
  const managedTitleFieldFor = createManagedTitleFieldLookup(cma);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  await mapWithConcurrency(entries, PATCH_CONCURRENCY, async (parent) => {
    try {
      const titleFieldId = await managedTitleFieldFor(parent);
      if (!titleFieldId) {
        skipped += 1;
        return;
      }

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
      if (newTitle === null) {
        skipped += 1;
        return;
      }

      const currentTitle = parent.fields[titleFieldId]?.[defaultLocale];
      if (newTitle === currentTitle) {
        skipped += 1;
        return;
      }

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

      await withRateLimitRetry(
        () =>
          cma.entry.patch(
            { entryId: parent.sys.id, version: parent.sys.version },
            ops,
          ),
        { context },
      );
      updated += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[auto-entry-title] ${context}: failed to propagate title for entry "${parent.sys.id}".`,
        err,
      );
    }
  });

  return { considered: entries.length, updated, skipped, failed };
};
