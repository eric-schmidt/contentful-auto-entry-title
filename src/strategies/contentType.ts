import type { FragmentStrategy } from "./types";

export const contentType = (): FragmentStrategy => {
  return ({ sdk, emit }) => {
    emit(sdk.contentType.name ?? sdk.contentType.sys.id);
    return () => {};
  };
};
