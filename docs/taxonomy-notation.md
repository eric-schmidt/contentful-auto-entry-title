# Taxonomy notation fragment

`conceptNotation` is the second fragment whose value lives entirely outside the
entry's own fields. Read this before changing `src/fragments/concepts.ts`,
`src/fragments/conceptReaderBrowser.ts`, or
`functions/shared/conceptReaderForFunction.ts`.

_What_ it produces is in
[Title composition](./title-composition.md#conceptnotation-schemeids). This
document is about _how concepts are read_, which is where the complexity is.

## Failure behaviour — read this first

This is the contract the rest of the app is built around, and getting it
backwards causes silent data loss.

A reader that rejects, or a context with no `conceptReader` at all, produces
`console.warn("[auto-entry-title] conceptNotation: …")` and returns **`null`, not
an empty string**. The fragment **never throws from `subscribe`**. From there:

1. `conceptNotation` returns `null` — "I could not find out".
2. `joinFragments` returns `null` for the **entire composed title**.
3. Every write path skips: `Field.tsx` doesn't call `setValue`, and
   `recomputeTitleForEntries` doesn't PATCH.
4. **The stored title is left exactly as it was.**

**So the symptom of a broken taxonomy read is titles that stop updating — never
titles that are missing their notation.** A missing delivery key means "titles
stop being maintained", not "titles lose their notation".

Why it has to work this way: a title composed without the notation looks
perfectly valid, and both write paths persist whatever they compose (the editor
autosaves, the Function PATCHes). Treating a failed read as `""` would **delete**
the `MRRL` blob from entries whose titles were already correct — on every entry
open, across a whole publish fan-out. `null` poisons the join instead, and the
warning in the log is the only visible symptom. That is what to grep for when
titles stop updating.

Two consequences worth knowing:

- The safe failure is also the **quieter** one. Check the function logs and the
  browser console for the warning.
- `conceptReader` is an _optional_ context key, so a code path that forgets to
  thread it through still compiles. It no longer corrupts data, but it does
  silently stop maintaining titles — which is why the dispatcher forwards it on
  **both** branches and `functions/handler/index.spec.ts` asserts it.

## Why concepts can't be observed like a field

Taxonomy concepts are **not fields**. They live on the entry's
`metadata.concepts` as a flat, mixed-scheme array of `Link<'TaxonomyConcept'>` —
e.g. `[2026, mens, rlx, spring]`, with no grouping by scheme. Two consequences:

- `sdk.entry.fields[id].onValueChanged(...)`, the mechanism every other fragment
  uses, **cannot see them**. `conceptNotation.subscribe` pairs
  `sdk.entry.getMetadata()` for the initial paint with
  `sdk.entry.onMetadataChanged(cb)` for updates. Both are on `EntryAPI`.
- The scheme a concept belongs to is not on the link. It has to come from the
  concept read itself.

`onMetadataChanged` may fire synchronously on subscribe. That's harmless —
`Field.tsx` skips the write when the composed title is unchanged.

### Expected: the title updates when you switch back to the Editor tab

Concepts are assigned on the entry editor's **Taxonomy** tab. This app renders on
the **Editor** tab, and the web app unmounts the inactive tab's DOM — so while
you are on Taxonomy, **this app is not running**. Adding or removing a concept
does not move the title at that moment; it updates when you navigate back.

That is expected, and not a bug in this app:

- Our iframe is destroyed on tab switch, so no `metadataChanged` message can be
  delivered to it. No polling or alternative subscription (`onSysChanged`, a
  timer, a sidebar location) changes that — none of them run either.
- On return, `onMetadataChanged` is a `MemoizedSignal`: it replays the current
  metadata the instant we resubscribe, which is precisely why switching back
  applies the change immediately.

The persisted title is still correct in every case, and the server-side path is
authoritative regardless. The one thing to know is the ordering consequence:

> **If you publish straight from the Taxonomy tab**, the entry goes live with a
> title that hasn't been recomputed — the widget wasn't mounted to recompute it.
> The `Entry.publish` handler then corrects the published entry's own title, but
> as a **draft write**: within a few seconds the entry shows as **"Changed"** with
> the right title in the draft, and **a human has to publish again** to make it
> live. The function deliberately does not republish (see
> [Recursion safety](./server-side-propagation.md#recursion-safety)).
>
> So this is a safety net, not a fix. Switching back to the Editor tab before
> publishing still gets it right the first time, as does the App Action below.
>
> Two cases where even the draft isn't corrected, both of which log a warning
> rather than writing a wrong title:
>
> - **The taxonomy read failed** (missing or unauthorized delivery key) — the
>   `null` path above; the stored title is left alone.
> - **The entry fetch failed** — the handler warns `failed to fetch the published
entry "<id>"` and continues with the fan-out; only that one entry's own title
>   goes uncorrected.

## Why the read is per-scheme, not per-concept

Neither transport offers a concept-**id** filter. The management SDK's
`GetManyConceptParams` accepts `{ pageUrl }` XOR `{ conceptScheme, query }`; the
CDA likewise exposes `conceptScheme` and nothing id-shaped. So the read is
inverted: fetch **each scheme once**, build a scheme→concepts map, then walk
`metadata.concepts` against it.

That is cheap here — Division and Brand hold 7 concepts total — and it means the
scheme is known from the _query_ rather than from the response. Which matters,
because of a real typing trap: `ConceptProps` is declared as
`Omit<Concept, 'conceptSchemes'>` over a base that never declared
`conceptSchemes`, so the typed shape is missing a field the wire response
actually returns. Knowing the scheme from the query sidesteps that entirely.

Reads follow cursor pagination via `pages.next` — there is **no `total`** and no
`skip` on this collection — up to a page cap, so growing a scheme past one page
doesn't silently truncate.

## Where taxonomy actually lives: the scoping table

This is the part that costs an afternoon to rediscover:

| Route                                                                           | Result                                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **CDA** `GET /spaces/{s}/environments/{e}/taxonomy/concepts?conceptScheme={id}` | ✅ **200** — returns `notations` and `conceptSchemes` verbatim          |
| CDA `/concepts`, `/taxonomy/concept_schemes`, `/concept_schemes`                | ❌ 404 on both `cdn` and `preview` hosts                                |
| **Space-scoped CMA** taxonomy                                                   | ❌ **404 — the route does not exist**                                   |
| **Org-scoped CMA** `concept.getMany`                                            | ✅ works                                                                |
| GraphQL CDA                                                                     | ❌ no concept/taxonomy root field                                       |
| An entry's own CDA response                                                     | ❌ does not inline concept notations; `includes` has no concept entries |

Taxonomy is **org-level**: the concepts are byte-identical across every
environment in the org. So a 404 from the CDA taxonomy route is almost never a
missing route or a missing concept — **it's the Delivery key not being authorized
for that environment.**

This is also why taxonomy reads do not go through app identity at all. Granting
the App Definition more CMA permissions will never fix a failing concept read.

## Two transports, one pure function

`ConceptReader` is the seam — `(schemeId) => Promise<ConceptRecord[]>`. Both
phases funnel into the same pure `notationForSchemes(...)`, so the two-phase
contract **cannot drift by accident**; a parity test in
`conceptNotation.spec.ts` pins `subscribe`'s last emit to `compute`'s return
across a table of concept sets.

|            | Editor (`subscribe`)                                                 | Function (`compute`)                                    |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| Transport  | plain `fetch` against `cdn.contentful.com`                           | plain `fetch` against `cdn.contentful.com`              |
| Scope      | space + environment                                                  | space + environment                                     |
| Credential | `CONTENTFUL_DELIVERY_KEY` via Vite's `envPrefix`                     | `CONTENTFUL_DELIVERY_KEY` inlined as `__DELIVERY_KEY__` |
| Caching    | memoized per scheme, module scope, never invalidated for the session | **uncached**                                            |
| Built by   | `src/fragments/conceptReaderBrowser.ts`                              | `functions/shared/conceptReaderForFunction.ts`          |

Both run the **same** `createCdaConceptReader` from `src/fragments/concepts.ts`;
only how the key arrives differs — see
[Build-time configuration](./build-time-config.md). Three things about this are
load-bearing:

- **`sdk.cma` / `sdk.cmaAdapter` cannot read concepts, and never will.** The App
  SDK's CMA proxy enforces a hardcoded entity allowlist — `CMAClient` in
  `@contentful/app-sdk/dist/types/cmaClient.types.d.ts` enumerates ~40 entity
  types and `concept` is **not** among them. Calling it anyway fails at runtime
  with `You can not access the entity type Concept from within an app.` That is
  the proxy refusing to route, not a permissions problem: `cmaAdapter` is scoped
  to `/spaces/{id}/environments/{id}` and taxonomy is org-level, so no permission
  grant, key, or TypeScript cast reaches concepts through it. An earlier version
  tried exactly that (`conceptReaderSdk.ts`, now deleted) — don't try it again.
- **A read-only Delivery key ships in the browser bundle.** This is the accepted
  cost of the above, and it is the ordinary way CDA keys are used in browser
  apps: it grants published-read on this one space and nothing more. The
  `envPrefix` rule that keeps it from dragging the management PAT along with it
  is in [Build-time configuration](./build-time-config.md).
- **App Actions were the alternative, and were rejected.** They are
  asynchronous-by-design with no synchronous response — you poll
  `createWithResult` — which would delay the title paint by seconds on every
  entry open.

The CDA taxonomy endpoint is browser-callable: `access-control-allow-origin: *`
with `authorization` among the allowed request headers, verified against
`cdn.contentful.com`. No proxy or CORS workaround is needed.

The function reader is deliberately **uncached**. Function instances are reused
across invocations, and a cache there would defeat the entire point of the repair
action — you'd recompute titles from the stale notations you were trying to fix.

## Editor-side staleness

`withConceptCache` memoizes by scheme, in-flight promises included, and is
**never invalidated for the session**. If a notation is edited in another tab,
the editor shows the old value until the entry is reopened. That is the same
accepted staleness window every cross-entry fragment has, and the server-side
path is authoritative. Don't add refresh logic to "fix" it.

## Propagating concept edits

Renaming a referenced _entry_ propagates via `Entry.publish` +
`links_to_entry`. Editing a _concept's notation_ has the reverse index but **no
event**:

- ✅ The reverse lookup exists: `entries?metadata.concepts.sys.id[in]={ids}` is
  the concept analogue of `links_to_entry`.
- ❌ **No App Event topic fires on a taxonomy change.** It isn't in the
  valid-topics list at all. There is nothing to subscribe to, which is why
  `functions/handler/index.ts` has no concept branch.

So propagation rides an **App Action** — `functions/handler/actions.ts`,
`accepts: ["appaction.call"]`, invoked manually. It takes a comma-separated
`conceptIds` parameter (App Action parameters are limited to
`Symbol | Enum | Number | Boolean`, so there is no array type), pages the reverse
lookup via `paginateEntries`, and delegates to the **existing**
`recomputeTitleForEntries` — the same per-entry loop, idempotency guard, and
draft write-back the event handlers use.

> A Contentful App Definition supports only one `appevent.handler` function,
> which is why `index.ts` is a topic dispatcher. That cap does **not** apply to
> `appaction.call`, so the action is legitimately its own entry point and bundle.
> Don't fold it into the dispatcher.

Recursion safety is inherited: the action patches drafts, so it emits
`Entry.save`, never `Entry.publish`, and cannot feed back into the rename path.
Re-running it is free — the `newTitle === currentTitle` check skips every
unchanged entry.

**To invoke it:** create an App Action call against `recomputeConceptTitles` with
`{"conceptIds": "mens,doubleRl"}` — via the CMA, the CLI, or `curl`. Register the
action first with `npm run upsert-actions`.

If no delivery key was inlined at build time, the action **bails without writing
anything** and warns. Deliberate: recomputing every title with no concept reader
would produce a `null` title for each one, and writing nothing is the whole point
of that guard.

### Known limitations

Stated plainly rather than papered over:

- **An unattended taxonomy edit propagates to nothing** until someone invokes the
  action, or each affected entry is next opened (whose `subscribe` re-reads live
  concepts, and the web app autosaves) or next published.
- **Nothing invokes the action at all** — not automatically, and not from the UI.
  This app registers only the `entry-field` location, so there is no rendered
  surface to hold a button; callers today are the CMA, the CLI, or `curl`. Giving
  it a page location with a concept picker, and moving its writes onto the Bulk
  Entry Content Operations API so a large repair doesn't hit the ~7 req/s CMA
  limit, is **planned but deferred** — see `TODO.md`. If _unattended_
  propagation ever becomes a hard requirement, the only real options are an
  external scheduled poller diffing `sys.updatedAt` on concepts, or Contentful
  shipping a taxonomy event topic — both out of scope.
- **Concept deletion** removes the link from `metadata.concepts`, which is an
  _entry_ change rather than a concept event — same gap, same repair paths.
- **The CDA reads published taxonomy state.** A concept edit not yet visible to
  the CDA won't appear. The org-scoped CMA is the read-your-writes path if that
  ever matters.
- **Season and Year are excluded by choice**, not by limitation — add them to
  `schemeIds`.
