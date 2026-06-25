import type {
  EntryProps,
  PlainClientAPI,
  ReleaseProps,
} from "contentful-management";
import { handleLinkedEntryPublish } from "./linkedEntryTitle";
import { handleReleaseOrScheduledActionEvent } from "./releaseDate";

const ENTRY_PUBLISH_TOPIC = "ContentManagement.Entry.publish";
const RELEASE_TOPIC_PREFIX = "ContentManagement.Release.";
const SCHEDULED_ACTION_TOPIC_PREFIX = "ContentManagement.ScheduledAction.";

type AppEvent = {
  headers: Record<string, string>;
  body: EntryProps | ReleaseProps | { sys: { type: string }; entity?: unknown };
};

// `context.cma` is a pre-initialized PlainClientAPI provided by the Contentful
// Functions runtime for management-context functions. Constructing our own
// client from `context.cmaClientOptions` fails with `AxiosError: Unknown
// adapter 'fetch'` because the bundled axios adapter resolution doesn't work
// inside the Functions runtime — `context.cma` is fetch-backed and works.
type FunctionContext = {
  cma: PlainClientAPI;
  spaceId: string;
  environmentId: string;
};

// Single appevent.handler for the auto-entry-title app. A Contentful App
// Definition supports only one App Event Subscription handler, so all topics
// (Entry.publish for linked-entry rename propagation, Release.* +
// ScheduledAction.* for Launch Release schedule changes) target this
// dispatcher. The dispatcher inspects `X-Contentful-Topic` and forwards to
// the appropriate per-domain module.
export const handler = async (
  event: AppEvent,
  context: FunctionContext,
): Promise<void> => {
  const topic = event.headers["X-Contentful-Topic"] ?? "";

  if (topic === ENTRY_PUBLISH_TOPIC) {
    await handleLinkedEntryPublish({
      cma: context.cma,
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
      environmentId: context.environmentId,
      topic,
      body: event.body as never,
    });
  }
};

export default handler;
