import { vi, type Mock } from "vitest";
import type { FragmentEmitter } from "./types";

export type MockFragmentEmitter = FragmentEmitter & Mock & { skip: Mock };

// Test helper: a `vi.fn()` shaped as a FragmentEmitter, with a `.skip` mock.
// Use this anywhere a fragment spec needs to pass an emitter into `subscribe`.
export const mockEmitter = (): MockFragmentEmitter => {
  const fn = vi.fn() as unknown as MockFragmentEmitter;
  fn.skip = vi.fn();
  return fn;
};
