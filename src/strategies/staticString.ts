import type { FragmentStrategy } from "./types";

export const staticString = (value: string): FragmentStrategy => {
  return ({ emit }) => {
    emit(value);
    return () => {};
  };
};
