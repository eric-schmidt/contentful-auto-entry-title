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
