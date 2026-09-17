// Purpose: the CMA offset-pagination loop, once. Two dispatch paths need every
// entry matching a query — `links_to_entry` in ../handler/linkedEntryTitle.ts,
// `metadata.concepts.sys.id[in]` in ../handler/actions.ts — and the loop around
// them was identical enough that one file already said "mirrors" the other.
//
// Query construction stays with the caller. The two queries mean different
// things and only their traversal is shared.
//
// Two guards this adds over the loops it replaces:
//
//   1. A non-numeric `total` terminates instead of spinning. `skip >= undefined`
//      is `false`, so a response missing `total` looped forever, re-requesting
//      the same page.
//   2. A page cap, mirroring `MAX_PAGES` in `src/fragments/concepts.ts`. It
//      warns rather than truncating silently. Note the CMA independently caps
//      `skip + limit` at 10,000, so an offset loop cannot reach past that
//      regardless of what we ask for.
//
// It also stops on a short page, which is both correct for the current API and
// cheaper than trusting a `total` that can shift while paginating.

import type { EntryProps, PlainClientAPI } from "contentful-management";

// The CMA caps `limit` at 1000. 100 is what both call sites used and is kept:
// these pages are fed straight into `recomputeTitleForEntries`, which PATCHes
// one entry at a time against a ~7 req/s budget, so larger reads buy nothing.
export const PAGE_SIZE = 100;

// 100 pages x 100 entries = 10,000, which is exactly the CMA's `skip + limit`
// ceiling. Hitting this means the query outgrew offset pagination, not that the
// loop misbehaved.
const MAX_PAGES = 100;

// Collects every entry matching `query`. `skip` and `limit` are supplied here —
// a caller passing its own would be overwritten, so it must not try.
export const paginateEntries = async (
  cma: PlainClientAPI,
  query: Record<string, unknown>,
  context: string,
): Promise<EntryProps[]> => {
  const all: EntryProps[] = [];
  let skip = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await cma.entry.getMany({
      query: { ...query, skip, limit: PAGE_SIZE },
    });
    const items = response.items as EntryProps[];
    all.push(...items);

    // A short page is the last page.
    if (items.length < PAGE_SIZE) return all;

    skip += PAGE_SIZE;

    // `total` is advisory here — the short-page check above is the real
    // terminator. This only stops us issuing one more request when the CMA has
    // told us how many there are.
    if (typeof response.total === "number" && skip >= response.total) return all;
  }

  console.warn(
    `[auto-entry-title] ${context}: stopped paginating at ${MAX_PAGES} pages ` +
      `(${all.length} entries). The CMA caps offset pagination at 10,000 ` +
      "entries, so some matches were not processed.",
  );
  return all;
};
