import type { EntryProps, PlainClientAPI, ReleaseProps } from "contentful-management";
import { resolveDefaultLocale } from "../shared/findManagedTitleFieldId";
import { recomputeTitleForEntries } from "../shared/recomputeTitleForEntries";

const RELEASE_TOPIC_PREFIX = "ContentManagement.Release.";
const SCHEDULED_ACTION_TOPIC_PREFIX = "ContentManagement.ScheduledAction.";

type ScheduledActionEventBody = {
  sys: { id: string; type: "ScheduledAction" };
  entity: { sys: { id: string; linkType: string } };
};

type Args = {
  cma: PlainClientAPI;
  appInstallationId: string;
  environmentId: string;
  topic: string;
  body: ReleaseProps | ScheduledActionEventBody;
};

const resolveReleaseId = (
  topic: string,
  body: Args["body"],
): string | null => {
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

// Handles Release.* and ScheduledAction.* events. For ScheduledAction events
// whose target isn't a Release, this is a no-op. For everything else, fetches
// the affected Release and recomputes the title of each entry member.
export const handleReleaseOrScheduledActionEvent = async ({
  cma,
  appInstallationId,
  environmentId,
  topic,
  body,
}: Args): Promise<void> => {
  const releaseId = resolveReleaseId(topic, body);
  if (!releaseId) return;

  const release = await safeReleaseGet(cma, releaseId);
  if (!release) return;

  const entryLinks = (release.entities?.items ?? []).filter(
    (link) => link.sys.linkType === "Entry",
  );
  if (!entryLinks.length) return;

  const defaultLocale = await resolveDefaultLocale(cma);

  // Hydrate each linked entry into a full EntryProps before recomputing.
  const entries: EntryProps[] = [];
  for (const link of entryLinks) {
    try {
      entries.push(await cma.entry.get({ entryId: link.sys.id }));
    } catch (err) {
      console.warn(
        `[auto-entry-title] releaseDate: failed to fetch release member "${link.sys.id}".`,
        err,
      );
    }
  }

  await recomputeTitleForEntries({
    cma,
    appInstallationId,
    environmentId,
    defaultLocale,
    entries,
    context: "releaseDate",
  });
};
