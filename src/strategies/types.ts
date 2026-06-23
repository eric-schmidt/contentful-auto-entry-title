import type { FieldAppSDK } from "@contentful/app-sdk";
import type { PlainClientAPI } from "contentful-management";

// Strategies emit a string for each value they want included in the joined
// title. A function-managed strategy (e.g., `publicationDate`) has no editor
// signal and calls `emit.skip()` instead, marking the slot as "no opinion".
// `Field.tsx` will not write to the field while any slot is in the skip state,
// preserving values that were written server-side by the propagator functions.
export type FragmentEmitter = {
  (fragment: string): void;
  skip: () => void;
};

export type FragmentStrategyContext = {
  sdk: FieldAppSDK;
  emit: FragmentEmitter;
};

export type FragmentComputeEntry = {
  sys: {
    id: string;
    contentType: { sys: { id: string } };
  };
  fields: Record<string, Record<string, unknown> | undefined>;
};

// Structural subset of contentful-management's PlainClientAPI covering only the
// methods the strategies and the propagator function actually call. Both
// `sdk.cma` (App SDK CMAClient) and a fresh `createClient({ type: "plain" })`
// satisfy this shape, so the same compute paths work in the editor and the
// Function.
export type FragmentCmaClient = {
  entry: Pick<PlainClientAPI["entry"], "get">;
  contentType: Pick<PlainClientAPI["contentType"], "get">;
  release: Pick<PlainClientAPI["release"], "query">;
  scheduledActions: Pick<PlainClientAPI["scheduledActions"], "getMany">;
};

export type FragmentComputeContext = {
  entry: FragmentComputeEntry;
  cma: FragmentCmaClient;
  defaultLocale: string;
  environmentId: string;
};

export type FragmentStrategy = {
  subscribe: (ctx: FragmentStrategyContext) => () => void;
  compute: (ctx: FragmentComputeContext) => Promise<string>;
};

export type FieldNameComposition = {
  fragments: FragmentStrategy[];
  separator?: string;
};
