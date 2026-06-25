import type { EntryProps, PlainClientAPI } from "contentful-management";
import { resolveDefaultLocale } from "../shared/findManagedTitleFieldId";
import { recomputeTitleForEntries } from "../shared/recomputeTitleForEntries";

const SOURCE_CONTENT_TYPE_ID = "region";
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

// Handles `Entry.publish` events for entries of content type `region`.
// Finds every entry that references the published Region and recomputes each
// referencing entry's auto-generated title.
export const handleRegionPublish = async ({
  cma,
  environmentId,
  sourceEntry,
}: Args): Promise<void> => {
  if (sourceEntry.sys.contentType.sys.id !== SOURCE_CONTENT_TYPE_ID) return;

  const defaultLocale = await resolveDefaultLocale(cma);
  const referencingEntries = await paginateLinksToEntry(cma, sourceEntry.sys.id);

  await recomputeTitleForEntries({
    cma,
    environmentId,
    defaultLocale,
    entries: referencingEntries,
    context: "regionTitle",
  });
};
