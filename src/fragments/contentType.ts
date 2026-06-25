// Purpose: Fragment that emits the display name of the entry's content
// type. Editor path reads the synchronous `sdk.contentType`; Function path
// fetches via CMA and falls back to the content-type id on failure.

import type { Fragment } from "./types";

export const contentType = (): Fragment => ({
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
