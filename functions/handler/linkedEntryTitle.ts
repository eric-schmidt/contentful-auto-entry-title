// Purpose: Entry.publish branch of the dispatcher. It does two jobs:
//
//   1. Recomputes the auto-title of the PUBLISHED ENTRY ITSELF. Concepts are
//      assigned on the entry editor's Taxonomy tab, where our field widget is
//      unmounted and therefore cannot recompute anything (see the tab-unmount
//      note in AGENTS.md). Publishing straight from that tab would otherwise
//      persist a stale title with no signal at all.
//   2. Finds every entry that links to it (via `links_to_entry`) and recomputes
//      their auto-titles. This is what makes a Brand/Region rename flow out to
//      every parent entry that references it.
//
// Both are DRAFT writes. Job 1 therefore leaves the entry in "Changed" state —
// correct title in the draft, the stale one still published — and a human has
// to publish again to make it live. Republishing programmatically was
// considered and rejected: it would make this the only path in the repo that
// publishes, which is the invariant the whole recursion-safety argument rests
// on (see ./actions.ts and README.md "Recursion safety").

import type { EntryProps, PlainClientAPI } from "contentful-management";
import type { ConceptReader } from "../../src/fragments/types";
import { resolveDefaultLocale } from "../shared/findManagedTitleFieldId";
import { recomputeTitleForEntries } from "../shared/recomputeTitleForEntries";

const PAGE_SIZE = 100;

type Args = {
  cma: PlainClientAPI;
  environmentId: string;
  // The App Event body. Deliberately used for `sys.id` ONLY — see the re-fetch
  // in the handler for why it must not reach `composeTitle`.
  sourceEntry: EntryProps;
  conceptReader?: ConceptReader;
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

// Handles `Entry.publish` events. Recomputes the published entry's own title,
// then every entry that references it (via the CMA's `links_to_entry` index).
// The second half generalizes the original "Region rename" propagation: any
// `referencedEntryTitle` fragment (Region, Brand, or future linked-entry
// references) gets free rename propagation through this path because
// `recomputeTitleForEntries` only writes to entries whose title field is
// actually bound to this app.
export const handleLinkedEntryPublish = async ({
  cma,
  environmentId,
  sourceEntry,
  conceptReader,
}: Args): Promise<void> => {
  const sourceId = sourceEntry.sys.id;
  const defaultLocale = await resolveDefaultLocale(cma);

  // Re-fetch rather than recomputing from the event body. Two independent
  // reasons, both of which silently DESTROY data if ignored:
  //
  //   - `metadata` is not guaranteed on an App Event body, and
  //     `conceptNotation.compute` reads `entry.metadata?.concepts`. Zero
  //     concept ids resolves to "" — NOT null — so a snapshot missing
  //     `metadata` composes a title without the notation blob, sails past the
  //     `null` guard in `recomputeTitleForEntries`, and PATCHes the truncated
  //     title over the correct one.
  //   - `sys.version` on the event body is already stale, so the PATCH would
  //     409. 409s are warned and swallowed, so the feature would look inert.
  //
  // Nothing in the type system stops you passing `event.body` here:
  // `FragmentComputeEntry` has `metadata` optional and no `sys.version` at all.
  // The same reasoning is why `releaseDate.ts` hydrates every release member.
  let source: EntryProps | undefined;
  try {
    source = await cma.entry.get({ entryId: sourceId });
  } catch (err) {
    // Isolated so a fetch failure costs only job 1, not the whole fan-out.
    console.warn(
      `[auto-entry-title] linkedEntryTitle: failed to fetch the published ` +
        `entry "${sourceId}"; its own title was not recomputed.`,
      err,
    );
  }

  const referencingEntries = await paginateLinksToEntry(cma, sourceId);

  // Source FIRST, and deduped. Order matters: `referencedEntryTitle.compute`
  // reads its linked entry's draft title over the CMA, so patching the source
  // before its parents means they see the corrected value in this same
  // invocation rather than staying stale until some later event. The dedupe
  // isn't just a saved request — `links_to_entry` returns self-links, and a
  // second pass over the pre-fetch snapshot would 409 and be swallowed. The
  // re-fetched copy wins: fresher version, and `metadata` guaranteed present.
  const entries = source
    ? [source, ...referencingEntries.filter((e) => e.sys.id !== sourceId)]
    : referencingEntries;

  await recomputeTitleForEntries({
    cma,
    environmentId,
    defaultLocale,
    entries,
    context: "linkedEntryTitle",
    conceptReader,
  });
};
