// Purpose: Fragment that emits the concatenated notations of the taxonomy
// concepts assigned to this entry — e.g. an entry tagged "Men's" (notation "M")
// and "Double RL" (notation "RRL") contributes "MRRL".
//
// Two things make this unlike every other fragment in this directory:
//
//   1. Concepts are not fields. They live on `metadata.concepts`, so
//      `sdk.entry.fields[id].onValueChanged` cannot observe them —
//      `getMetadata()` + `onMetadataChanged()` are the reactive pair instead.
//   2. Concept reads need a transport neither `sdk.cma` nor `context.cma`
//      provides (see src/fragments/concepts.ts), so the reader arrives as an
//      optional context key rather than through `FragmentCmaClient`.
//
// Both phases funnel into the same `resolveConceptNotation`, which is what
// keeps the editor render and the Function recompute from drifting.
//
// The emitted value is ONE string, joined internally with "". If this returned
// one fragment per scheme, the composition's " - " separator would land inside
// the blob as "M - RRL".

import type { Metadata } from "@contentful/app-sdk";
import { resolveConceptNotation } from "./concepts";
import type { ConceptReader, Fragment } from "./types";

type Options = {
  // Both the filter and the output order: only concepts in these schemes
  // contribute, and the blob is assembled scheme by scheme, independent of the
  // order `metadata.concepts` happens to list them in. Adding Season/Year later
  // is a one-line change here.
  schemeIds: string[];
};

const conceptIdsFrom = (
  concepts: { sys: { id: string } }[] | undefined,
): string[] => (concepts ?? []).map((concept) => concept.sys.id);

// Single resolve path for both phases. Never throws — a throw from `subscribe`
// would break the whole composition — and distinguishes the two flavours of
// "no string" that `FragmentEmitter` documents:
//
//   ""    the entry genuinely has no notation to contribute (no concepts).
//   null  the notation is UNKNOWN because the taxonomy read didn't happen.
//
// The `null` cases must not resolve to "". A title composed without the
// notation looks perfectly valid, and both write paths persist it — the editor
// autosaves, the Function PATCHes — so returning "" here would DELETE the
// `MRRL` blob from entries whose titles were previously correct, every time a
// key is missing or the CDA is unreachable. `null` aborts the write instead and
// leaves the stored title untouched.
const safeResolve = async ({
  conceptIds,
  schemeIds,
  conceptReader,
}: {
  conceptIds: string[];
  schemeIds: string[];
  conceptReader: ConceptReader | undefined;
}): Promise<string | null> => {
  if (conceptIds.length === 0) return "";

  if (!conceptReader) {
    // Loud rather than silent: the reader is an optional context key, so a
    // recompute path that forgets to thread it through would otherwise quietly
    // strip the notation from every title it rewrites.
    console.warn(
      "[auto-entry-title] conceptNotation: no conceptReader in context; " +
        "the title will be left as-is rather than rewritten without its " +
        "notation.",
    );
    return null;
  }

  try {
    return await resolveConceptNotation({
      conceptIds,
      schemeIds,
      reader: conceptReader,
    });
  } catch (err) {
    console.warn(
      "[auto-entry-title] conceptNotation: failed to read taxonomy concepts; " +
        "leaving the title as-is.",
      err,
    );
    return null;
  }
};

export const conceptNotation = ({ schemeIds }: Options): Fragment => ({
  subscribe: ({ sdk, emit, conceptReader }) => {
    let cancelled = false;

    const run = (metadata?: Metadata) => {
      void safeResolve({
        conceptIds: conceptIdsFrom(metadata?.concepts),
        schemeIds,
        conceptReader,
      }).then((notation) => {
        if (!cancelled) emit(notation);
      });
    };

    // Initial paint, then live updates. `onMetadataChanged` may fire
    // synchronously on subscribe; that's harmless because Field.tsx's recompute
    // no-ops when the joined title is unchanged.
    run(sdk.entry.getMetadata());
    const unsubscribe = sdk.entry.onMetadataChanged(run);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  },
  compute: ({ entry, conceptReader }) =>
    safeResolve({
      conceptIds: conceptIdsFrom(entry.metadata?.concepts),
      schemeIds,
      conceptReader,
    }),
});
