import type { EntryProps, PlainClientAPI, ReleaseProps } from "contentful-management";
import { resolveDefaultLocale } from "../shared/findManagedTitleFieldId";
import { recomputeTitleForEntries } from "../shared/recomputeTitleForEntries";

const RELEASE_TOPIC_PREFIX = "ContentManagement.Release.";
const SCHEDULED_ACTION_TOPIC_PREFIX = "ContentManagement.ScheduledAction.";
const RELEASE_DELETE_TOPIC = "ContentManagement.Release.delete";

// Backoff schedule for retrying the release fetch. Release.save / archive
// events can fire before the new release-side state is fully queryable; a
// short retry covers that consistency window. Max wait ~3.75s total.
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

type EntryLink = { sys: { type: "Link"; linkType: "Entry"; id: string } };

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

const extractEntryLinks = (release: ReleaseProps): EntryLink[] =>
  ((release.entities?.items ?? []) as EntryLink[]).filter(
    (link) => link.sys.linkType === "Entry",
  );

// Fetch the release with retries, returning the first response that has at
// least one Entry member. The release entity can be served back without its
// new membership immediately after Release.save / Release.archive — this
// retry bridges that consistency window. Returns null if the release no
// longer exists (e.g., already deleted).
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
    if (extractEntryLinks(release).length > 0) return release;
  }
  return lastResponse;
};

// Handles Release.* and ScheduledAction.* events. Drives a recompute of each
// affected entry's auto-generated title.
//
// Member resolution:
//   - For Release.delete: the release is gone, so we MUST rely on the event
//     body's entities array — there's no post-delete fetch.
//   - For Release.archive / save / create: we refetch via cma.release.get
//     (with retries to cover the release-side consistency window). Archived
//     releases stay queryable.
//   - For ScheduledAction.* events: we refetch the release the action targets.
export const handleReleaseOrScheduledActionEvent = async ({
  cma,
  environmentId,
  topic,
  body,
}: Args): Promise<void> => {
  const releaseId = resolveReleaseId(topic, body);
  if (!releaseId) return;

  let entryLinks: EntryLink[];

  if (topic === RELEASE_DELETE_TOPIC) {
    // The release no longer exists. Use the entities the event body delivered.
    const deletedRelease = body as ReleaseProps;
    entryLinks = extractEntryLinks(deletedRelease);
    if (!entryLinks.length) {
      console.warn(
        `[auto-entry-title] releaseDate: Release.delete payload had no Entry members; the deleted release "${releaseId}" left orphan dates on its former member entries.`,
      );
      return;
    }
  } else {
    const release = await safeReleaseGetWithMembers(cma, releaseId);
    if (!release) return;
    entryLinks = extractEntryLinks(release);
    if (!entryLinks.length) return;
  }

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
