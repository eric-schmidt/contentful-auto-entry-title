import type { FragmentStrategy } from "./types";

export const staticString = (value: string): FragmentStrategy => ({
  subscribe: ({ emit }) => {
    emit(value);
    return () => {};
  },
  compute: async () => value,
});
