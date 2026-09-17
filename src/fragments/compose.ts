// Purpose: Pure joining logic shared by editor and Function paths. Empty
// fragments are filtered BEFORE the separator is applied so a missing slot
// (e.g. no scheduled date) doesn't leave a dangling " - " in the title.
//
// A `null` fragment is not empty but UNKNOWN, and it poisons the whole join:
// both helpers return `null`, which every caller must treat as "do not write".
// Joining around it would emit a title that looks complete while silently
// missing a piece, and persisting that deletes the real value.

import type { FieldNameComposition, FragmentComputeContext } from "./types";

export const joinFragments = (
  fragments: (string | null)[],
  separator: string | undefined,
): string | null =>
  fragments.some((s) => s === null)
    ? null
    : fragments.filter((s) => s !== "").join(separator ?? "");

// Returns `null` when any fragment reported an unknown value — see the header.
// A fragment that *throws* still degrades to "": that's the documented contract
// and unchanged. Only an explicit `null` return aborts the title.
export const composeTitle = async (
  composition: FieldNameComposition,
  ctx: FragmentComputeContext,
): Promise<string | null> => {
  const fragments = await Promise.all(
    composition.fragments.map((s) => s.compute(ctx).catch(() => "")),
  );
  return joinFragments(fragments, composition.separator);
};
