import type { EntryProps, PlainClientAPI, ReleaseProps } from "contentful-management";
import { handleRegionPublish } from "./regionTitle";
import { handleReleaseOrScheduledActionEvent } from "./releaseDate";

const ENTRY_PUBLISH_TOPIC = "ContentManagement.Entry.publish";
const RELEASE_TOPIC_PREFIX = "ContentManagement.Release.";
const SCHEDULED_ACTION_TOPIC_PREFIX = "ContentManagement.ScheduledAction.";

type AppEvent = {
  headers: Record<string, string>;
  body: EntryProps | ReleaseProps | { sys: { type: string }; entity?: unknown };
};

type FunctionContext = {
  cma: PlainClientAPI;
  appInstallationId: string;
  environmentId: string;
};

// Single appevent.handler for the auto-entry-title app. A Contentful App
// Definition supports only one App Event Subscription handler, so all topics
// (Entry.publish for Region renames, Release.* + ScheduledAction.* for
// schedule changes) target this dispatcher. The dispatcher inspects
// `X-Contentful-Topic` and forwards to the appropriate per-domain module.
export const handler = async (
  event: AppEvent,
  context: FunctionContext,
): Promise<void> => {
  const topic = event.headers["X-Contentful-Topic"] ?? "";

  if (topic === ENTRY_PUBLISH_TOPIC) {
    await handleRegionPublish({
      cma: context.cma,
      appInstallationId: context.appInstallationId,
      environmentId: context.environmentId,
      sourceEntry: event.body as EntryProps,
    });
    return;
  }

  if (
    topic.startsWith(RELEASE_TOPIC_PREFIX) ||
    topic.startsWith(SCHEDULED_ACTION_TOPIC_PREFIX)
  ) {
    await handleReleaseOrScheduledActionEvent({
      cma: context.cma,
      appInstallationId: context.appInstallationId,
      environmentId: context.environmentId,
      topic,
      body: event.body as never,
    });
    return;
  }

  // Unknown topic — no-op. The subscription should never deliver a topic we
  // don't recognize, but if it does, dropping it silently is safer than
  // throwing (which would surface as a failed function invocation).
};

export default handler;
