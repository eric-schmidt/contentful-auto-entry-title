// Purpose: Entry.publish branch of the dispatcher. When any entry is
// published, find every entry that links to it (via `links_to_entry`) and
// recompute their auto-titles. This is what makes a Brand/Region rename
// flow out to every parent entry that references it.

import type { EntryProps, PlainClientAPI } from "contentful-management";
import { resolveDefaultLocale } from "../shared/findManagedTitleFieldId";
import { recomputeTitleForEntries } from "../shared/recomputeTitleForEntries";

const PAGE_SIZE = 100;

type Args = {
  cma: PlainClientAPI;
  environmentId: string;
  sourceEntry: EntryProps;
};

const paginateLinksToEntry = async (
  cma: PlainClientAPI,
  entryId: string,
): Promise<EntryProps[]> => {
  const all: EntryProps[] = [];
  let skip = 0;
  while (true) {
    const page = await cma.entry.getMany({
      query: { links_to_entry: entryId, skip, limit: PAGE_SIZE },
    });
    all.push(...(page.items as EntryProps[]));
    skip += PAGE_SIZE;
    if (skip >= page.total) break;
  }
  return all;
};

// Handles `Entry.publish` events. Finds every entry that references the
// published entry (via the CMA's `links_to_entry` index) and recomputes its
// auto-generated title. This generalizes the original "Region rename"
// propagation: any `referencedEntryTitle` fragment (Region, Brand, or future
// linked-entry references) gets free rename propagation through this path
// because `recomputeTitleForEntries` only writes to entries whose title field
// is actually bound to this app.
export const handleLinkedEntryPublish = async ({
  cma,
  environmentId,
  sourceEntry,
}: Args): Promise<void> => {
  const defaultLocale = await resolveDefaultLocale(cma);
  const referencingEntries = await paginateLinksToEntry(cma, sourceEntry.sys.id);

  await recomputeTitleForEntries({
    cma,
    environmentId,
    defaultLocale,
    entries: referencingEntries,
    context: "linkedEntryTitle",
  });
};
