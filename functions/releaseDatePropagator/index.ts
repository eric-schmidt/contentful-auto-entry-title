import type { EntryProps, PlainClientAPI, ReleaseProps } from "contentful-management";
import { composition } from "../../src/fragments";
import { composeTitle } from "../../src/fragments/compose";
import {
  findManagedTitleFieldId,
  resolveDefaultLocale,
} from "../shared/findManagedTitleFieldId";

const RELEASE_TOPIC_PREFIX = "ContentManagement.Release.";
const SCHEDULED_ACTION_TOPIC_PREFIX = "ContentManagement.ScheduledAction.";

type ScheduledActionEventBody = {
  sys: { id: string; type: "ScheduledAction" };
  entity: { sys: { id: string; linkType: string } };
};

type AppEvent = {
  headers: Record<string, string>;
  body: ReleaseProps | ScheduledActionEventBody;
};

type FunctionContext = {
  cma: PlainClientAPI;
  appInstallationId: string;
  environmentId: string;
};

const resolveReleaseId = (topic: string, body: AppEvent["body"]): string | null => {
  if (topic.startsWith(RELEASE_TOPIC_PREFIX)) {
    return body.sys.id;
  }
  if (topic.startsWith(SCHEDULED_ACTION_TOPIC_PREFIX)) {
    const sa = body as ScheduledActionEventBody;
    if (sa.entity?.sys?.linkType !== "Release") return null;
    return sa.entity.sys.id;
  }
  return null;
};

const safeReleaseGet = async (
  cma: PlainClientAPI,
  releaseId: string,
): Promise<ReleaseProps | null> => {
  try {
    return await cma.release.get({ releaseId });
  } catch {
    // Release no longer exists (e.g., this is a ScheduledAction.delete that
    // arrived after the Release itself was deleted). We can't recover the
    // membership list — accept the loss and exit cleanly.
    return null;
  }
};

export const handler = async (event: AppEvent, context: FunctionContext): Promise<void> => {
  const topic = event.headers["X-Contentful-Topic"] ?? "";
  const releaseId = resolveReleaseId(topic, event.body);
  if (!releaseId) return;

  const { cma, appInstallationId, environmentId } = context;
  const release = await safeReleaseGet(cma, releaseId);
  if (!release) return;

  const entryLinks = (release.entities?.items ?? []).filter(
    (link) => link.sys.linkType === "Entry",
  );
  if (!entryLinks.length) return;

  const defaultLocale = await resolveDefaultLocale(cma);

  for (const link of entryLinks) {
    try {
      const parent: EntryProps = await cma.entry.get({ entryId: link.sys.id });
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
        `[auto-entry-title] failed to propagate release date for entry "${link.sys.id}".`,
        err,
      );
    }
  }
};

export default handler;
