import type { FragmentStrategy } from "./types";

export const contentType = (): FragmentStrategy => ({
  subscribe: ({ sdk, emit }) => {
    emit(sdk.contentType.name ?? sdk.contentType.sys.id);
    return () => {};
  },
  compute: async ({ entry, cma }) => {
    const contentTypeId = entry.sys.contentType.sys.id;
    try {
      const ct = await cma.contentType.get({ contentTypeId });
      return ct.name ?? contentTypeId;
    } catch {
      return contentTypeId;
    }
  },
});
