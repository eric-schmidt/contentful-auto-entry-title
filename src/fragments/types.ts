// Purpose: Core contract for the title-composition system. A Fragment is the
// unit of composition with two execution modes: `subscribe` (live in the
// editor, push updates via `emit`) and `compute` (one-shot from CMA data in
// the propagation Function). Both modes share the same value convention: a
// string is a contribution, "" is "nothing to contribute" and gets dropped from
// the join, and `null` is "I could not find out" and aborts the write — see
// `FragmentEmitter` for why that third case has to exist.

import type { FieldAppSDK } from "@contentful/app-sdk";
import type { PlainClientAPI } from "contentful-management";

// Fragments emit a string for each value they want included in the joined
// title. Empty strings are filtered out of the join, so emitting "" is the
// idiomatic way to signal "this slot has nothing to contribute right now."
//
// `null` means something different and stronger: "I could not determine my
// contribution." The distinction is load-bearing. "" and `null` would otherwise
// produce the same shortened title, and writing that title back DELETES real
// data — the editor autosaves it, the Function PATCHes it — so a failed
// taxonomy read would silently strip `MRRL` out of every title it touched.
// `null` therefore suppresses the write entirely and leaves the stored title
// alone. Only emit it for a genuine failure; "nothing to contribute" is "".
export type FragmentEmitter = (fragment: string | null) => void;

export type FragmentContext = {
  sdk: FieldAppSDK;
  emit: FragmentEmitter;
  conceptReader?: ConceptReader;
};

export type FragmentComputeEntry = {
  sys: {
    id: string;
    contentType: { sys: { id: string } };
  };
  fields: Record<string, Record<string, unknown> | undefined>;
  // Taxonomy concept links live on `metadata`, not `fields`, so a fragment
  // that reads concepts needs this rather than a field id. Optional because
  // an entry created before taxonomy was in use has no `metadata` at all —
  // `conceptNotation` treats absent metadata as "nothing to contribute".
  metadata?: { concepts?: { sys: { id: string } }[] };
};

// Structural subset of contentful-management's PlainClientAPI covering only the
// methods the fragments and the propagator function actually call. Both
// `sdk.cma` (App SDK CMAClient) and a fresh `createClient({ type: "plain" })`
// satisfy this shape, so the same compute paths work in the editor and the
// Function.
//
// Deliberately NOT widened with taxonomy: the App SDK's `CMAClient` type has no
// `concept` key, so adding one here would stop `sdk.cma` satisfying this shape
// and break the invariant stated directly above. There is also no space-scoped
// CMA taxonomy route at all (it 404s), so `context.cma` inside a Function
// couldn't serve concept reads even if the type allowed it. A capability beyond
// this client's reach is passed as its own optional context key instead — see
// `ConceptReader` below.
export type FragmentCmaClient = {
  entry: Pick<PlainClientAPI["entry"], "get">;
  contentType: Pick<PlainClientAPI["contentType"], "get">;
  release: Pick<PlainClientAPI["release"], "query">;
  scheduledActions: Pick<PlainClientAPI["scheduledActions"], "getMany">;
};

// A taxonomy concept, reduced to what title composition needs. `notations` is
// the short code an editor sets on the concept ("M", "RRL"); unlike
// `prefLabel` it is NOT a locale map, so there is no locale to resolve.
export type ConceptRecord = {
  id: string;
  notations: string[];
};

// Reads every concept belonging to one concept scheme. Fetching per scheme
// rather than per concept is deliberate: neither the CDA nor the management
// SDK offers a concept-id filter, while both filter by scheme, and the schemes
// in play hold a handful of concepts each. Both runtimes implement this with the
// SAME CDA transport from src/fragments/concepts.ts — only the source of the
// delivery key differs (an esbuild define in the Function, `import.meta.env` in
// the editor). The App SDK's CMA proxy cannot read concepts at all; see
// src/fragments/conceptReaderBrowser.ts.
export type ConceptReader = (schemeId: string) => Promise<ConceptRecord[]>;

export type FragmentComputeContext = {
  entry: FragmentComputeEntry;
  cma: FragmentCmaClient;
  defaultLocale: string;
  environmentId: string;
  // Optional so every existing caller of `composeTitle` keeps compiling. A
  // fragment that needs it warns and returns `null` when it's absent rather
  // than throwing, so a recompute path that forgets to thread it through skips
  // the write instead of silently stripping the notation from the title.
  conceptReader?: ConceptReader;
  // Set ONLY by a caller that already knows a scheduled action ought to exist —
  // in practice the Release.* / ScheduledAction.* branch, where the event is
  // itself that evidence. It licenses `publicationDate` to retry an empty
  // scheduled-action read while Contentful's read-after-write window settles.
  //
  // Leaving it unset is the right default everywhere else: for an entry that
  // simply isn't scheduled, empty is the permanent answer, and retrying it once
  // per entry across a fan-out is what produced CMA 429s. See
  // SCHEDULE_LOOKUP_RETRY_DELAYS_MS in publicationDate.ts.
  awaitScheduleConsistency?: boolean;
};

export type Fragment = {
  subscribe: (ctx: FragmentContext) => () => void;
  // `null` carries the same meaning as in `FragmentEmitter`: not "empty" but
  // "unknown", which aborts the caller's write rather than shortening the
  // title. See the comment there.
  compute: (ctx: FragmentComputeContext) => Promise<string | null>;
};

export type FieldNameComposition = {
  fragments: Fragment[];
  separator?: string;
};
