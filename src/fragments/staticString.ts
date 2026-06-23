import type { Fragment } from "./types";

export const staticString = (value: string): Fragment => ({
  subscribe: ({ emit }) => {
    emit(value);
    return () => {};
  },
  compute: async () => value,
});
