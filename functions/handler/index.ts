// Purpose: The single `appevent.handler` entry point declared in
// contentful-app-manifest.json. Because Contentful caps an App Definition at
// one app-event handler, this file is a topic dispatcher — it reads the
// `X-Contentful-Topic` header and forwards to per-domain handlers.

import type {
  EntryProps,
  PlainClientAPI,
  ReleaseProps,
} from "contentful-management";
import { conceptReaderForFunction } from "../shared/conceptReaderForFunction";
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
//
// Consequence worth knowing before reaching for an SDK option: because this
// client is injected as an `apiAdapter`, it never goes through
// `RestAdapter`/`createHttpClient`, which is the only place contentful-sdk-core
// installs its rate-limit interceptor. So `retryOnError` / `retryLimit` /
// `throttle` are unavailable here (passing them alongside `apiAdapter` is even a
// type error), and 429 handling has to be explicit — see
// ../shared/rateLimit.ts.
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

  // Passed to BOTH branches. Every recompute runs the whole composition, which
  // includes `conceptNotation` — a branch that omits this would strip the
  // notation blob out of each title it rewrites. Built lazily so an ignored
  // topic doesn't emit a missing-key warning it can do nothing about.
  //
  // There is deliberately no concept branch here: no App Event topic fires on a
  // taxonomy change, so there is nothing to subscribe to. Concept edits
  // propagate through the App Action in ./actions.ts instead.
  const buildConceptReader = () =>
    conceptReaderForFunction({
      spaceId: context.spaceId,
      environmentId: context.environmentId,
      context: "dispatcher",
    });

  if (topic === ENTRY_PUBLISH_TOPIC) {
    await handleLinkedEntryPublish({
      cma: context.cma,
      environmentId: context.environmentId,
      sourceEntry: event.body as EntryProps,
      conceptReader: buildConceptReader(),
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
      conceptReader: buildConceptReader(),
    });
  }
};

export default handler;
