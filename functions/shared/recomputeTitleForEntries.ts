import type { EntryProps, PlainClientAPI } from "contentful-management";
import { composition } from "../../src/fragments";
import { composeTitle } from "../../src/fragments/compose";
import { findManagedTitleFieldId } from "./findManagedTitleFieldId";

type Args = {
  cma: PlainClientAPI;
  appInstallationId: string;
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
//   - otherwise update the entry as a draft
// Per-parent failures are logged and skipped so one bad entry doesn't block
// the rest.
export const recomputeTitleForEntries = async ({
  cma,
  appInstallationId,
  environmentId,
  defaultLocale,
  entries,
  context,
}: Args): Promise<void> => {
  for (const parent of entries) {
    try {
      const titleFieldId = await findManagedTitleFieldId(cma, parent, appInstallationId);
      if (!titleFieldId) continue;

      const newTitle = await composeTitle(composition, {
        entry: parent,
        cma,
        defaultLocale,
        environmentId,
      });
      const currentTitle = parent.fields[titleFieldId]?.[defaultLocale];
      if (newTitle === currentTitle) continue;

      parent.fields[titleFieldId] = {
        ...(parent.fields[titleFieldId] ?? {}),
        [defaultLocale]: newTitle,
      };

      await cma.entry.update({ entryId: parent.sys.id }, parent);
    } catch (err) {
      console.warn(
        `[auto-entry-title] ${context}: failed to propagate title for entry "${parent.sys.id}".`,
        err,
      );
    }
  }
};
