import type { EntryProps, PlainClientAPI, ReleaseProps } from "contentful-management";
import { resolveDefaultLocale } from "../shared/findManagedTitleFieldId";
import { recomputeTitleForEntries } from "../shared/recomputeTitleForEntries";

const RELEASE_TOPIC_PREFIX = "ContentManagement.Release.";
const SCHEDULED_ACTION_TOPIC_PREFIX = "ContentManagement.ScheduledAction.";

// Backoff schedule for retrying the release fetch. `Release.save` events can
// fire before the corresponding release-side write is fully queryable; a
// short retry covers that window. Max wait ~3.75s total.
const RELEASE_FETCH_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000];

type ScheduledActionEventBody = {
  sys: { id: string; type: "ScheduledAction" };
  entity: { sys: { id: string; linkType: string } };
};

type Args = {
  cma: PlainClientAPI;
  environmentId: string;
  topic: string;
  body: ReleaseProps | ScheduledActionEventBody;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Fetch the release with retries, returning the first response that has at
// least one Entry member. The release entity can be served back without its
// new membership immediately after a Release.save event — this retry bridges
// that consistency window. Returns null if the release no longer exists.
const safeReleaseGetWithMembers = async (
  cma: PlainClientAPI,
  releaseId: string,
): Promise<ReleaseProps | null> => {
  let lastResponse: ReleaseProps | null = null;
  for (const delay of RELEASE_FETCH_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    let release: ReleaseProps;
    try {
      release = await cma.release.get({ releaseId });
    } catch {
      return null;
    }
    lastResponse = release;
    const entryCount = (release.entities?.items ?? []).filter(
      (link) => link.sys.linkType === "Entry",
    ).length;
    if (entryCount > 0) return release;
  }
  return lastResponse;
};

// Handles Release.* and ScheduledAction.* events. For ScheduledAction events
// whose target isn't a Release, this is a no-op. For everything else, fetches
// the affected Release and recomputes the title of each entry member.
export const handleReleaseOrScheduledActionEvent = async ({
  cma,
  environmentId,
  topic,
  body,
}: Args): Promise<void> => {
  const releaseId = resolveReleaseId(topic, body);
  if (!releaseId) return;

  const release = await safeReleaseGetWithMembers(cma, releaseId);
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
    environmentId,
    defaultLocale,
    entries,
    context: "releaseDate",
  });
};
