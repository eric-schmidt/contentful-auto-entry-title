// Purpose: Pure joining logic shared by editor and Function paths. Empty
// fragments are filtered BEFORE the separator is applied so a missing slot
// (e.g. no scheduled date) doesn't leave a dangling " - " in the title.

import type { FieldNameComposition, FragmentComputeContext } from "./types";

export const joinFragments = (
  fragments: string[],
  separator: string | undefined,
): string => fragments.filter((s) => s !== "").join(separator ?? "");

export const composeTitle = async (
  composition: FieldNameComposition,
  ctx: FragmentComputeContext,
): Promise<string> => {
  const fragments = await Promise.all(
    composition.fragments.map((s) => s.compute(ctx).catch(() => "")),
  );
  return joinFragments(fragments, composition.separator);
};
