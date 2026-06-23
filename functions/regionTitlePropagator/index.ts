import type { EntryProps, PlainClientAPI } from "contentful-management";
import { composition } from "../../src/strategies";
import { composeTitle } from "../../src/strategies/compose";
import {
  findManagedTitleFieldId,
  resolveDefaultLocale,
} from "../shared/findManagedTitleFieldId";

const SOURCE_CONTENT_TYPE_ID = "region";
const TOPIC = "ContentManagement.Entry.publish";
const PAGE_SIZE = 100;

type AppEvent = {
  headers: Record<string, string>;
  body: EntryProps;
};

type FunctionContext = {
  cma: PlainClientAPI;
  appInstallationId: string;
  environmentId: string;
};

type CmaEntry = EntryProps;

const paginateLinksToEntry = async (
  cma: PlainClientAPI,
  entryId: string,
): Promise<CmaEntry[]> => {
  const all: CmaEntry[] = [];
  let skip = 0;
  while (true) {
    const page = await cma.entry.getMany({
      query: { links_to_entry: entryId, skip, limit: PAGE_SIZE },
    });
    all.push(...(page.items as CmaEntry[]));
    skip += PAGE_SIZE;
    if (skip >= page.total) break;
  }
  return all;
};

export const handler = async (event: AppEvent, context: FunctionContext): Promise<void> => {
  if (event.headers["X-Contentful-Topic"] !== TOPIC) return;

  const sourceEntry = event.body;
  if (sourceEntry.sys.contentType.sys.id !== SOURCE_CONTENT_TYPE_ID) return;

  const { cma, appInstallationId, environmentId } = context;
  const defaultLocale = await resolveDefaultLocale(cma);
  const referencingEntries = await paginateLinksToEntry(cma, sourceEntry.sys.id);

  for (const parent of referencingEntries) {
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
        `[auto-entry-title] failed to propagate title for entry "${parent.sys.id}".`,
        err,
      );
    }
  }
};

export default handler;
