import { vi, type Mock } from "vitest";
import type { FragmentEmitter } from "./types";

export type MockFragmentEmitter = FragmentEmitter & Mock;

// Test helper: a `vi.fn()` shaped as a FragmentEmitter.
// Use this anywhere a fragment spec needs to pass an emitter into `subscribe`.
export const mockEmitter = (): MockFragmentEmitter =>
  vi.fn() as unknown as MockFragmentEmitter;
