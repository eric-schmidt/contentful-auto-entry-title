# TODO

Deferred work, with enough context to resume cold. Nothing here is a bug in
shipped behaviour — these are known-incomplete paths.

## Give `recomputeConceptTitles` a UI, and make its writes bulk

**Status:** deferred by decision (2026-09-17). The App Action exists and works;
nothing can invoke it, and its write pattern won't scale.

### Where this stands today

`functions/handler/actions.ts` is a working `appaction.call` entry point. It
takes comma-separated `conceptIds`, pages the reverse index
(`metadata.concepts.sys.id[in]=…`) at 100, and delegates to the shared
`recomputeTitleForEntries`. It is declared in `contentful-app-manifest.json`
under `actions[]` as `recomputeConceptTitles`, and covered by
`functions/handler/actions.spec.ts`.

**But nothing invokes it.** `grep` finds the action id only in the manifest and
in README prose — there is no caller anywhere in the repo. `src/App.tsx`
registers exactly one location, `LOCATION_ENTRY_FIELD`, whose widget is a
disabled text input, so the app has no rendered surface that could hold a
button. Invoking it today means a hand-rolled CMA `appActionCall` create, the
CLI, or `curl`.

Also worth checking first: the `actions[]` block has **no stamped remote action
id**, which suggests `npm run upsert-actions` has never run against the App
Definition. If so, the action isn't registered and even a hand-rolled call
would 404.

### Why it exists at all

Editing a concept's *notation* (e.g. changing what `MRRL` renders as) fires
**no App Event** — taxonomy changes aren't in the valid-topics list, so
`functions/handler/index.ts` has nothing to subscribe to. The reverse index
does exist, so propagation was one trigger short of working. That gap is real.

It is, however, narrower than "propagation": stale notations partly heal on
their own. Opening an entry recomputes and autosaves the corrected draft title
(modulo the session-scoped concept cache in `withConceptCache`, so it needs a
reload if that entry was already opened this session), and publishing an entry
recomputes server-side with a fresh concept read. So the action's real value is
**bulk repair without touching entries one at a time** — an ops convenience,
not a correctness requirement.

### What we decided to do

Option 3 of three considered: **finish it** — add a location that can render a
control, rather than cutting the action or leaving it invokable-only-by-curl.
Leaving it as-is was explicitly rejected: cost with no benefit, and it reads to
a future maintainer as a working feature.

### Part 1 — the UI

Add a location that can hold a trigger. Neither the entry-field widget nor a
sidebar is a good fit (a concept-wide repair isn't scoped to one entry), so the
likely shape is a **page location** with a concept picker calling
`sdk.cma.appActionCall.createWithResponse`.

Open questions to settle when picking this up:

- Where do the selectable concepts come from? The editor cannot read Concepts
  through `sdk.cma` at all (entity allowlist), so the picker needs the same
  CDA-based reader the field widget uses — `createBrowserConceptReader` +
  `withConceptCache`, currently constructed per space/environment in
  `Field.tsx`. That map may want lifting somewhere shared.
- `useAutoResizer` throws in the `page` location — do not carry it over from
  `Field.tsx`.
- The manifest needs the new location declared, and `src/App.tsx` needs it in
  `ComponentLocationSettings`.
- The action must actually be registered: run `npm run upsert-actions`, which
  **rewrites the manifest in place** (stamps the remote id, reformats JSON) and
  whose diff should be committed.

### Part 2 — bulk writes, to stop the 429s

**The motivating problem.** `recomputeTitleForEntries` is a sequential
`for` loop doing one `cma.entry.patch` per entry, with **no 429 handling
anywhere** — no retry, no backoff, no throttle. The CMA caps around 7 req/s,
and per entry the loop also spends fragment reads (`referencedEntryTitle` does
a `cma.entry.get`, `publicationDate` hits scheduled-actions). A concept applied
to a few hundred entries will rate-limit. This repo has already been burned by
429 storms once — that is why
`createManagedTitleFieldLookup` memoizes editor interfaces per content type.

**Intended direction:** use the **Bulk Entry Content Operations** API for the
write side of the action. Confirmed constraints from the docs, all of which
shape the design:

- It is a **different API from `bulkAction`**. The SDK's `cma.bulkAction.*`
  (v12.8.0) only does publish / unpublish / validate — there is **no bulk
  update** there, so the entry-update path is **not** reachable through the
  plain client and means raw `fetch` against
  `.../bulk_operations/entries/update`.
- It is **asynchronous**: POST returns a job id, then you poll
  `GET .../bulk_operations/{id}` until `sys.status` is `completed` / `failed`.
  A per-item `result.items[]` reports `succeeded` / `failed` **even when the
  job completes**, so error handling has two levels.
- **Updates are PUT-like and overwrite the whole entry**: each item needs
  `sys.id`, a matching `sys.version`, and **`fields` in full** — omitted fields
  are **removed**. Our current write is a *surgical JSON-Patch* on one title
  field. This is the biggest risk in the whole item: getting it wrong deletes
  content. It also means the version-conflict window widens from one PATCH to
  an upload-plus-poll cycle.
- There's an **upload step**: POST the JSON array to
  `https://upload.contentful.com/...` first, then reference the returned
  `Upload` id. That host is **outside the manifest's current
  `allowNetworks: ["*.contentful.com"]`** — it will need adding, or the
  function's request is blocked.
- **Only one bulk operation may be in flight per space**; a second returns
  `409 Conflict`. Concurrent invocations need serializing or a 409 retry.
- Cap is **10,000 entries** per operation.

Worth deciding whether the simpler fix is enough before absorbing all that: a
**concurrency limiter plus 429 retry-with-backoff** inside
`recomputeTitleForEntries` would fix the rate limiting without the
whole-entry-overwrite hazard, and would benefit the two event handlers too, not
just the action. Bulk operations win on request count; the sequential loop wins
on write safety and on reusing the existing idempotency guard. Bulk also can't
easily preserve the `newTitle === currentTitle` skip, since the whole payload is
assembled before the job runs.

### Invariants any implementation must not break

- **Draft writes only.** `cma.entry.patch` is the only CMA mutation in the repo
  and there are zero `.publish()` calls. That is what makes recursion safety
  *structural*: draft writes emit `Entry.save`, which the dispatcher doesn't
  route. A bulk **publish** would re-enter the `Entry.publish` handler.
- **Never write a title composed without a concept reader.** The action already
  bails when no delivery key was inlined. Recomputing every title with no
  reader strips the notation from all of them — silent data loss, and the
  reason for the `null` convention documented in `AGENTS.md`.
- **Entries reaching `composeTitle` must be CMA-fetched**, never event-body or
  partial snapshots — absent `metadata` composes to `""` rather than `null` and
  strips the notation.

### Pointers

- `functions/handler/actions.ts` — the action, with its own rationale header.
- `functions/shared/recomputeTitleForEntries.ts` — the loop that would change.
- `src/App.tsx`, `src/locations/Field.tsx` — location registration, and the
  concept-reader construction to reuse.
- `README.md` "Propagating concept edits" → "Known limitations" — the
  user-facing statement of this gap, which should shrink when this lands.
