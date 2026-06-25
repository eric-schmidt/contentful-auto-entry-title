// Purpose: Core contract for the title-composition system. A Fragment is the
// unit of composition with two execution modes: `subscribe` (live in the
// editor, push updates via `emit`) and `compute` (one-shot from CMA data in
// the propagation Function). Both modes share the same emit-empty-on-failure
// convention so the joiner can drop missing slots cleanly.

import type { FieldAppSDK } from "@contentful/app-sdk";
import type { PlainClientAPI } from "contentful-management";

// Fragments emit a string for each value they want included in the joined
// title. Empty strings are filtered out of the join, so emitting "" is the
// idiomatic way to signal "this slot has nothing to contribute right now."
export type FragmentEmitter = (fragment: string) => void;

export type FragmentContext = {
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
// methods the fragments and the propagator function actually call. Both
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

export type Fragment = {
  subscribe: (ctx: FragmentContext) => () => void;
  compute: (ctx: FragmentComputeContext) => Promise<string>;
};

export type FieldNameComposition = {
  fragments: Fragment[];
  separator?: string;
};
