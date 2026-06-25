// Purpose: Fragment that emits a fixed literal string. Useful for namespacing
// or constant prefixes in a composition.

import type { Fragment } from "./types";

export const staticString = (value: string): Fragment => ({
  subscribe: ({ emit }) => {
    emit(value);
    return () => {};
  },
  compute: async () => value,
});
