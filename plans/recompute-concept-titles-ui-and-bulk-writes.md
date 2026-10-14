# Give `recomputeConceptTitles` a UI, and make its writes survive rate limits

## Context

`functions/handler/actions.ts` is a working `appaction.call` entry point that
repairs auto-titles after a taxonomy concept's notation changes (no App Event
fires on taxonomy edits, so a manual trigger is the only option). It works, but
**nothing can invoke it** — the app registers only `LOCATION_ENTRY_FIELD`, whose
widget is a disabled text input, so there is no surface to hold a button.
Invoking it today means curl or a hand-rolled CMA call.

This plan closes that gap: a **page location** that lets non-technical users pick
concepts and run the repair, plus the rate-limit and timeout work needed to make
the repair actually finish.

### The requested mechanism is unavailable — decision recorded

The original ask was to use the **Bulk Entry Content Operations API** for the
writes. That is **not reachable from this app**, verified from both directions:

- **From the Function:** `BulkContentOperation` authorization is deliberately
  restricted to space/org **admin user tokens**. App Identity tokens get
  `AccessDenied: "You do not have permissions to create on BulkContentOperation"`.
  Internal support ticket 231133 is this exact scenario (an App Action function
  that could upload the payload and bulk _publish_, but not bulk _update_ nor
  read job status). Support's verdict: _"There isn't currently a way to grant the
  app identity itself the BulkContentOperation permissions… expected behavior
  rather than a misconfiguration."_
- **From the browser:** `sdk.cma` executes as the app, not the logged-in admin,
  and its allowlist (`@contentful/app-sdk/dist/types/cmaClient.types.d.ts`) has
  no `bulkOperation` key. Raw paths via `sdk.cmaAdapter` are rejected outright.
  A space admin opening the page cannot lend their permissions.

Three further findings that would have shaped it anyway:

- Bulk update is a **full PUT**. `metadata.concepts` must be echoed back
  explicitly or **taxonomy concepts are stripped from every entry** — precisely
  the data loss this app exists to prevent.
- Bulk is **asynchronous** (submit + poll), and Functions are killed at **30s**
  with no retry, so the job often could not be awaited in-function.
- Bulk fixes the wrong half. The 429 pressure is mostly **reads** (`composeTitle`
  does a `cma.entry.get` per reference plus scheduled-action lookups), which
  happen before any write. Bulk collapses only the PATCHes.

One TODO.md claim is simply wrong and needs correcting in that file:
`upload.contentful.com` **is** matched by the existing
`allowNetworks: ["*.contentful.com"]`. No manifest network change was ever needed.

**Chosen instead:** a concurrency limiter + 429 retry/backoff around the existing
surgical `cma.entry.patch` — TODO.md's own fallback. It preserves the JSON-Patch
write (no overwrite hazard), keeps the `newTitle === currentTitle` idempotency
skip, needs no new permissions, and also benefits the two event handlers.

### The 30s timeout forces batching (scope this plan adds deliberately)

At ~7 req/s and ~3 requests per entry, a few hundred entries needs **minutes**.
The Function is terminated at 30s **mid-batch, with no retry and no error**, so a
single-invocation design silently truncates and reports success. Throttling alone
makes this _worse_ (slower ⇒ fewer entries before the axe).

So the action becomes **resumable**: bounded work per call, with the page driving
the loop and rendering progress. This also sidesteps a second 30s trap —
`createWithResult` defaults to 15 retries × 2000ms and then **rejects while the
action is still running** (`APP_ACTION_CALL_RETRIES`/`APP_ACTION_CALL_RETRY_INTERVAL`
in contentful-management 12.8.0).

---

## Part 1 — Server: resumable, throttled writes

### `functions/shared/rateLimit.ts` — **LANDED**

Two helpers, no dependencies, both implemented and specced:

- `mapWithConcurrency(items, limit, fn)` — bounded-parallel map, input order
  preserved.
- `withRateLimitRetry(fn, { context })` — retries 429/5xx honouring
  `x-contentful-ratelimit-reset`, then exponential backoff with jitter, bounded
  by a retry ceiling **and** a total sleep budget (so backoff can't consume the
  30s invocation).

Built on `sleep` from `src/fragments/retry.ts`, but **not** `retryOverDelays` —
that one is value-driven, and a 429 is a throw, so it re-throws on the first
attempt.

**Why the SDK cannot do this for us** (verified against contentful-management
12.8.0 / contentful-sdk-core 9.x, replacing the earlier hedge that `context.cma`
merely "does not guarantee" 429 handling):

`retryOnError` (default `true`), `retryLimit` (5) and `throttle` are installed by
sdk-core's `createHttpClient` as **axios interceptors**, and its only caller is
`RestAdapter`. `createAdapter` never reaches it when an adapter is supplied:

```js
if ("apiAdapter" in params) {
  return params.apiAdapter;
} else {
  return new RestAdapter(params);
}
```

`sdk.cma` (postMessage adapter) and `context.cma` (fetch-backed) are both
`apiAdapter` clients, so no axios instance exists and no interceptor is
installed. Those options aren't merely ignored — `ClientOptions` is
`XOR<RestAdapterParams, AdapterParams>`, so passing them alongside `apiAdapter`
is a **type error**. Nor can we build our own: 12.8.0 ships only an axios
adapter, hence `Unknown adapter 'fetch'` in the Functions runtime.

Two corrections to the original wording here: sdk-core reads
**`x-contentful-ratelimit-reset` in seconds** and does **not** read `Retry-After`
(this plan previously named it), and it does **not** retry **409** — a
version-pinned `entry.patch` conflict must not be replayed.

### `functions/shared/recomputeTitleForEntries.ts` (edit) — **LANDED**

- Wrap each `cma.entry.patch` in `withRateLimitRetry`.
- Run entries through `mapWithConcurrency` at a **low** limit (start at 3;
  per-entry fragment reads mean effective RPS is a multiple of this).
- **Return counts instead of `void`:**
  `{ considered, updated, skipped, failed }`. Today per-entry failures are
  swallowed with a `console.warn` and nothing is reported, so the UI could not
  distinguish a clean run from one that failed on every entry.
- Keep unchanged: the two-branch `ops` construction (the title field may be
  absent entirely), the `newTitle === null` guard, the
  `newTitle === currentTitle` skip, and **no `.publish()`** — draft-only writes
  are what makes recursion safety structural.

Both existing callers (`linkedEntryTitle.ts`, `releaseDate.ts`) gain the
throttling for free; they may ignore the new return value.

### `functions/handler/actions.ts` (edit)

Add `skip` and `limit` (App Action params support `Number`) and return a cursor:

```ts
export type ActionResult = {
  conceptIds: string[];
  entriesConsidered: number; // kept for backwards compatibility
  updated: number;
  skipped: number;
  failed: number;
  nextSkip: number | null; // null === done
  totalEstimate?: number; // for the progress bar
};
```

Page one window of the reverse index per invocation, recompute it, return
`nextSkip`. Order by `sys.id` so skip-based paging is stable across writes (a
title change does not alter the concept-tag filter, so the result set is stable).
Default `limit` conservatively (~25) to stay well inside 30s.

Unchanged invariants: bail when no concept reader (a missing delivery key must
never write notation-stripped titles), and entries reaching `composeTitle` stay
CMA-fetched.

Also declare the two new parameters in `contentful-app-manifest.json`
`actions[0].parameters`.

---

## Part 2 — Browser: the page location

### `src/fragments/conceptReaderBrowser.ts` (edit)

`createBrowserConceptReader` touches only `sdk.ids.space` / `sdk.ids.environment`,
but its `FieldAppSDK` parameter blocks page reuse (`PageAppSDK` is not
assignable). Widen structurally:

```ts
export type SpaceEnvironmentIds = {
  ids: { space: string; environment: string };
};
```

### `src/fragments/conceptReaderCache.ts` (new)

Lift `Field.tsx`'s module-scope reader map verbatim — same
`${space}/${environment}` key, same `has`/`get` so `undefined` stays cached and
the missing-key warning still fires once. `Field.tsx` deletes its local copy and
imports this; call site unchanged, so both Field specs keep passing. Field and
Page now share one cache — consistent with the documented mount-time staleness
policy; note it in `docs/taxonomy-notation.md`.

### Concept labels

`ConceptReader` returns only `{ id, notations }` — no human-readable name. Carry
`prefLabel` through additively (`src/fragments/types.ts`, `concepts.ts`):

```ts
export type ConceptRecord = {
  id: string;
  notations: string[];
  prefLabel?: string | Record<string, string>;
};
```

In `toConceptRecords`, spread conditionally (`...(item.prefLabel === undefined ? {} : { prefLabel: item.prefLabel })`)
so no existing `toEqual` fixture changes and `notationForSchemes` / the
`conceptNotation` parity table are untouched.

`src/fragments/conceptLabels.ts` (new) resolves the display string, handling a
flat string, a locale map, and absence — degrading to the concept id.
**Verify the real CDA `prefLabel` shape against a live space before shipping**;
the docs confirm concepts carry localized labels but not the exact wire shape.

Export `COMPOSED_SCHEME_IDS = ["division", "brand"]` from `src/fragments/index.ts`
so the picker can never offer a concept the composition ignores.

### `src/locations/Page.tsx` (new)

**Component choice: `Checkbox.Group`, not Autocomplete or Multiselect.**
`Multiselect` does **not** exist in the pinned `f36-components@4.81.1` (verified;
the `f36-multiselect` on disk is a v6 transitive that would double-load the F36
core). With ~7 concepts across both schemes a grouped checkbox list is better
anyway: no popover, no filtering, keyboard/AT-correct, and **no Downshift**, so
the known Autocomplete re-select bug never arises. `EmptyState` and `Workbench`
are also absent — use `Note` + `Flex`/`Box`.

One `FormControl` + `Checkbox.Group` per scheme, each concept labelled by
`prefLabel` with its notation as a `Badge`, plus a muted hint when a concept has
no notation (repairing it is a no-op).

Do **not** use `useAutoResizer` (throws in `page`) and do not copy
`sdk.window.startAutoResizer()` — `BaseAppSDK` has no `window`, so it will not
even typecheck.

States: loading (`SkeletonContainer`), missing delivery key → warning `Note` +
disabled trigger, reader rejected → negative `Note` + Retry (safe:
`withConceptCache` evicts rejections), empty → neutral `Note`.

### `src/locations/recomputeConceptTitles.ts` (new)

Owns the batch loop and the result narrowing.

```ts
export const RECOMPUTE_CONCEPT_TITLES_ACTION_ID = "recomputeConceptTitles";
```

- Call `sdk.cma.appActionCall.createWithResult`. **Omit `spaceId`/`environmentId`** —
  `sdk.cma` already carries them as client defaults.
- **Status lives under `sys`**: `call.sys.status` / `call.sys.result` /
  `call.sys.error`, not at the top level.
- Raise `retries`/`retryInterval` above the 30s default, and treat a timeout
  rejection (`"taking longer than expected to process."`) as **indeterminate**,
  never as failure.
- `result` is `JsonValue`; validate it against `ActionResult` (import the type
  from `functions/handler/actions.ts` — type-only, so nothing from `functions/`
  enters the browser bundle) and fall back to an "unrecognised result" state.
- Loop on `nextSkip`, accumulating counts, invoking `onProgress` per batch.

`appDefinitionId` comes from `sdk.ids.app` (optional on `PageAppSDK`) — guard and
show a blocking `Note` if absent. Never reach for `__APP_DEFINITION_ID__`; that
define is Function-only.

**Registration probe:** on mount, call `sdk.cma.appAction.getManyForEnvironment`
(allowlisted, defaults supplied) and check the action exists. If not, say "run
`npm run upsert-actions`" _before_ the user clicks, turning an opaque 404 into an
actionable message. Treat a failure of the probe itself as non-blocking.

### Progress and result UI

Per-batch progress (`updated`/`considered` against `totalEstimate`) with the
trigger in `isLoading`, and a note that the repair continues server-side.

Copy must stay honest — counts are now real, so report `updated` and `failed`
separately, and treat **`considered === 0` as a warning, not success**: it is
ambiguous between "no entries carry these concepts" and "the server had no
delivery key and bailed without writing". Point at the Functions log for
`conceptNotationAction`. Use `sdk.notifier` (F36 `Notification` portals inside
the iframe and gets clipped).

### `src/App.tsx` (edit)

Add `[locations.LOCATION_PAGE]: Page`. The file predates the prettier convention
(single quotes); reformat it in the same commit.

---

## Verification

1. `npx tsc --noEmit` — **the only typecheck gate**; `npm run build` does not typecheck.
2. `npm run test:ci` (not `npm test`, which is watch mode).

New specs, each with its own local `buildSdk()` per repo convention (no central
SDK mock; `vi.mock` factories for `fieldEditorMocks` must be `async` +
`await import`):

- `recomputeConceptTitles.spec.ts` — the `sys.status` narrowing, the comma-joined
  `conceptIds` parameter, `ActionResult` validation, timeout → indeterminate
  (not failed), and **the batch loop following `nextSkip` to completion**.
- `Page.spec.tsx` — renders a checkbox per concept labelled by `prefLabel`;
  trigger disabled with nothing selected; success/failure/indeterminate surfaces;
  `considered === 0` warns; missing `ids.app`, missing delivery key, reader
  rejection, unregistered action.
- `conceptReaderCache.spec.ts` — one reader per space/env, and `undefined` cached
  (warning fires once) — an invariant nothing currently tests.
- `conceptLabels.spec.ts` — locale map, flat string, absent → id.
- `rateLimit.spec.ts` — concurrency ceiling respected; 429 retried honouring
  `RateLimit-Reset`; give up after N.
- `actions.spec.ts` (edit) — returns `nextSkip` when more remain and `null` at the
  end; still never publishes. Existing assertions on exact patch ops and the
  101-patch pagination test need updating for the batched/throttled shape.

End-to-end (needs a real space):

1. `npm run build && npm run upload`, then `npm run upsert-actions` — it
   **rewrites the manifest in place**; commit the diff. Note its diff may be a
   pure reformat: `upsert-actions` uses the manifest id as the remote id, so an
   unchanged id is **not** evidence it didn't run. Confirm from stdout or the
   page's probe.
2. `npm run add-locations` → select Page (writes to the App Definition, not the
   manifest). Give it main-nav placement so it is findable.
3. Open the page, select a concept whose notation you just edited, run it, and
   confirm titles change and the counts match.
4. Confirm no 429s in the Functions log, and that a run larger than one batch
   completes across several invocations rather than dying at 30s.

## Docs to update

`TODO.md` (Part 1 done; rewrite Part 2 around the App-Identity blocker and drop
the incorrect `allowNetworks` claim), `README.md` "Known limitations",
`docs/taxonomy-notation.md` (how to invoke it; shared reader cache), and
`AGENTS.md` (pointer to `conceptReaderCache.ts`, the rate-limit helpers, and the
`BulkContentOperation` finding so nobody re-attempts it).

## Follow-ups, not in scope

- **A memory-worthy platform fact:** `BulkContentOperation` is admin-user-token
  only — App Identities cannot use bulk entry operations at all. Worth saving to
  the global store, since it applies to every App Framework project.
- `contentful-management@12.8.0` has **no** `bulkOperation` binding (only the
  legacy publish/unpublish/validate `bulkAction`), so even with permissions this
  would mean raw HTTP.
- The CDA `/taxonomy/concepts` route documents a `sys.id[in]` filter, which
  appears to contradict AGENTS.md's "no concept-id filter" note. Worth verifying;
  it could simplify concept reads, but nothing here depends on it.
