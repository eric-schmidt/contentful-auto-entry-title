// Purpose: The `appaction.call` entry point — a manually invoked repair for
// titles whose taxonomy notation has gone stale.
//
// Why an App Action rather than an event branch: there is NO App Event topic
// for taxonomy changes. Editing a concept's notation fires nothing, so the
// dispatcher in ./index.ts has nothing to subscribe to. The reverse index does
// exist (`metadata.concepts.sys.id[in]=…`, the concept analogue of
// `links_to_entry`), so given the concept ids all that's missing is a trigger —
// which is what this provides.
//
// The one-handler-per-App-Definition cap that forced ./index.ts to become a
// topic dispatcher applies only to `appevent.handler`. An App Definition may
// carry any number of `appaction.call` functions, so this is a separate entry
// point rather than another branch of the dispatcher.
//
// Recursion is safe for free: `recomputeTitleForEntries` PATCHes drafts and
// never publishes, so no `Entry.publish` fires back into the dispatcher. Reruns
// are cheap because it skips entries whose recomputed title already matches.
//
// TWO THINGS THIS DOES NOT HAVE YET, both deferred deliberately — see TODO.md:
// nothing in the repo invokes it (there is no app location that could hold a
// button, so callers are the CMA / CLI / curl), and the write path inherits
// `recomputeTitleForEntries`' one-PATCH-per-entry loop with no 429 handling, so
// a concept applied to a few hundred entries will rate-limit against the ~7
// req/s CMA cap.

import type { PlainClientAPI } from "contentful-management";
import { conceptReaderForFunction } from "../shared/conceptReaderForFunction";
import { resolveDefaultLocale } from "../shared/findManagedTitleFieldId";
import { paginateEntries } from "../shared/paginateEntries";
import { recomputeTitleForEntries } from "../shared/recomputeTitleForEntries";

const CONTEXT = "conceptNotationAction";

// App Action parameters are limited to Symbol | Enum | Number | Boolean — there
// is no array type — so concept ids arrive as one comma-separated Symbol.
type AppActionEvent = {
  body: {
    conceptIds?: string;
  };
};

type FunctionContext = {
  cma: PlainClientAPI;
  spaceId: string;
  environmentId: string;
};

export type ActionResult = {
  conceptIds: string[];
  entriesConsidered: number;
};

const parseConceptIds = (raw: string | undefined): string[] => [
  ...new Set(
    (raw ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
  ),
];

// Recomputes the auto-title of every entry tagged with any of `conceptIds`.
// Invoke this after editing a concept's notation — nothing does so
// automatically, by design; see docs/taxonomy-notation.md ("Propagating
// concept edits").
export const handler = async (
  event: AppActionEvent,
  context: FunctionContext,
): Promise<ActionResult> => {
  const conceptIds = parseConceptIds(event.body?.conceptIds);

  if (conceptIds.length === 0) {
    console.warn(
      `[auto-entry-title] ${CONTEXT}: no conceptIds supplied; nothing to do.`,
    );
    return { conceptIds, entriesConsidered: 0 };
  }

  const conceptReader = conceptReaderForFunction({
    spaceId: context.spaceId,
    environmentId: context.environmentId,
    context: CONTEXT,
  });

  // Without a reader every recomputed title would come out MISSING its
  // notation — strictly worse than leaving the stale titles alone. So bail
  // rather than write.
  if (!conceptReader) return { conceptIds, entriesConsidered: 0 };

  const defaultLocale = await resolveDefaultLocale(context.cma);
  // One query covers all the concept ids at once: `[in]` works on
  // `metadata.concepts.sys.id` (unlike the scheduled-actions `entity.sys.id`
  // filter, where it is silently ignored).
  const entries = await paginateEntries(
    context.cma,
    { "metadata.concepts.sys.id[in]": conceptIds.join(",") },
    CONTEXT,
  );

  await recomputeTitleForEntries({
    cma: context.cma,
    environmentId: context.environmentId,
    defaultLocale,
    entries,
    context: CONTEXT,
    conceptReader,
  });

  return { conceptIds, entriesConsidered: entries.length };
};

export default handler;
