import type { EntryProps, PlainClientAPI } from "contentful-management";
import { composition } from "../../src/fragments";
import { composeTitle } from "../../src/fragments/compose";
import { findManagedTitleFieldId } from "./findManagedTitleFieldId";

type Args = {
  cma: PlainClientAPI;
  environmentId: string;
  defaultLocale: string;
  entries: EntryProps[];
  // Used in error logs to identify which propagation flow surfaced the failure.
  context: string;
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
}: Args): Promise<void> => {
  for (const parent of entries) {
    try {
      const titleFieldId = await findManagedTitleFieldId(cma, parent);
      if (!titleFieldId) continue;

      const newTitle = await composeTitle(composition, {
        entry: parent,
        cma,
        defaultLocale,
        environmentId,
      });
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
