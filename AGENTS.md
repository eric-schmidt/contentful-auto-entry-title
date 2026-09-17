# AGENTS.md

This file provides guidance to AI Agents when working with code in this repository.

## What this is

A Contentful App Framework field editor (React + Vite + TypeScript) that auto-generates entry titles by composing ordered fragments. Server-side propagation of cross-entry renames and release-schedule changes runs as a Contentful Function (`functions/handler/`).

Node version is pinned to v22 in `.nvmrc`.

## Commands

- `npm run dev` — Vite dev server on localhost:3000
- `npm run build` — builds the Vite app **and** bundles the function (`build:functions`)
- `npm run test:ci` — vitest run-once mode. **Use this before declaring work done; `npm test` is watch mode.**
- `npm run upload` — interactive upload of `build/` to Contentful. Reads `CONTENTFUL_ACCESS_TOKEN` from the environment; without it, every run opens a browser OAuth flow and prompts for a token paste.
- `npm run upload-ci` — non-interactive upload (uses `CONTENTFUL_ORG_ID`, `CONTENTFUL_APP_DEF_ID`, `CONTENTFUL_ACCESS_TOKEN`)
- `npm run upsert-actions` — registers the manifest's `actions[]` against the App Definition. `upsert-actions-ci` reads the same env trio as `upload-ci`. **Rewrites the manifest in place.**

## Where to look for X

When a non-obvious question comes up, the answer usually lives in a doc comment in the file below — read it before guessing.

- **How a fragment works / how to add one** → `src/fragments/types.ts` (the `Fragment` interface and its two-phase contract), then any existing fragment as a worked example.
- **Why `subscribe` and `compute` both exist on every fragment** → `src/fragments/publicationDate.ts` header comment. Short version: `subscribe` runs in the editor, `compute` runs in the Function, and both must agree.
- **What gets concatenated and how** → `src/fragments/compose.ts` (`joinFragments` filters out empty strings before joining).
- **What the current composition is** → `src/fragments/index.ts`. This is the only place to edit ordering / fragment choice. Field IDs (`description`, `regions`) and taxonomy scheme IDs (`division`, `brand`) are hardcoded here. Note there is no `brands` _field_ — Brand is taxonomy-only, and the old `referencedEntryTitle({ fieldId: "brands" })` slot was dead code.
- **How taxonomy concepts are read, and why per-scheme rather than per-concept** → `src/fragments/concepts.ts` header. Short version: neither the CDA nor the management SDK has a concept-id filter, and there is NO space-scoped CMA taxonomy route (it 404s) — only org-scoped CMA or env-scoped CDA.
- **Why the editor reads concepts over the CDA instead of `sdk.cma`** → `src/fragments/conceptReaderBrowser.ts` header. The App SDK's CMA proxy enforces a hardcoded entity allowlist (`CMAClient` in `@contentful/app-sdk/dist/types/cmaClient.types.d.ts`, which has no `concept` key) and is scoped to a space/environment while taxonomy is org-level, so concepts are unreachable through it by design — calling it anyway fails at runtime with `You can not access the entity type Concept from within an app.` No permission grant, key, or TS cast changes that. The cost of the workaround is a read-only Delivery key in the browser bundle.
- **Why the `Entry.publish` handler re-fetches the published entry instead of using the event body, and why it doesn't republish** → `functions/handler/linkedEntryTitle.ts` header. Short version: an event body may lack `metadata`, which silently strips the taxonomy notation out of the title it then writes; and republishing would break the structural recursion guard.
- **Why concept propagation is an App Action rather than an event** → `functions/handler/actions.ts` header. No App Event topic fires on a taxonomy change; the reverse index (`metadata.concepts.sys.id[in]`) exists but there is nothing to subscribe to.
- **Why the delivery key is a build-time define rather than an installation parameter** → `functions/shared/conceptReaderForFunction.ts` header. A deployed Function has no env-var mechanism, so those are the only two channels; the define keeps `.env` as the single source, at the cost of a credential inside the uploaded bundle and rotation needing a rebuild + re-upload.
- **Why the App Definition ID is a build-time global** → `functions/shared/findManagedTitleFieldId.ts` header. The function runtime doesn't expose it, so we `define` it via esbuild.
- **Why our esbuild config skips Node polyfills** → `esbuild.functions.config.js` header. Including them silently breaks the Functions runtime.
- **Why we use `context.cma` and not a fresh CMA client** → `functions/handler/index.ts` (`FunctionContext` comment). Building our own throws `Unknown adapter 'fetch'`.
- **Release / ScheduledAction event dispatch logic** → `functions/handler/releaseDate.ts` header on `handleReleaseOrScheduledActionEvent`. Member resolution differs across delete vs. save/archive vs. ScheduledAction.
- **Why ScheduledActions queries use `entity.sys.id` (singular) and one request per release id** → `src/fragments/publicationDate.ts` (`fetchMatchingScheduledActions` comment). The `[in]` filter is silently ignored by the CMA.
- **Why there's a retry loop on schedule lookups** → `src/fragments/publicationDate.ts` (`SCHEDULE_LOOKUP_RETRY_DELAYS_MS`) and `functions/handler/releaseDate.ts` (`RELEASE_FETCH_RETRY_DELAYS_MS`). Release.save fires before the ScheduledAction / release-member state is fully queryable.
- **Why the field is rendered disabled but not via a field-level disable** → `src/locations/Field.tsx` inline comment. Contentful does not let you UI-disable a title field; field-level perms are the only path.

## `CONTENTFUL_ACCESS_TOKEN` — the name is fixed by the CLI

**Do not rename it to `CONTENTFUL_MANAGEMENT_TOKEN`** (this was tried, and reverted). `@contentful/app-scripts` hardcodes the name as `ACCESS_TOKEN_ENV_KEY = 'CONTENTFUL_ACCESS_TOKEN'` in its `constants.js`, and exposes no flag to change it. `getManagementToken` reads `process.env.CONTENTFUL_ACCESS_TOKEN`, validates it against `getCurrentUser()`, and falls back to a browser OAuth flow plus an interactive paste when it is absent — so the *interactive* `npm run upload` and `npm run upsert-actions` silently start prompting on every run if the variable is named anything else.

Worse for tidiness: after such a prompt the CLI **appends the token back into `.env` under its own name** (`cacheEnvVars`), so a rename doesn't stick — you end up with both names in the file.

The `-ci` variants pass `--token $CONTENTFUL_ACCESS_TOKEN` explicitly, so *they* would work under any name; `scripts/import-content-model.mts` reads it directly too. The interactive commands are the binding constraint. Keep all four on the one name.

## Build-time env var

`CONTENTFUL_APP_DEF_ID` must be set when running `build:functions` — `esbuild.functions.config.js` inlines it as the `__APP_DEFINITION_ID__` global. Build fails explicitly if missing. Any code that needs the app definition ID at function runtime should read `__APP_DEFINITION_ID__`, not `process.env`. In tests, stub via `vi.stubGlobal`.

`CONTENTFUL_DELIVERY_KEY` (taxonomy reads at function runtime) is inlined too, as `__DELIVERY_KEY__` — but unlike the app definition id, a missing key **warns instead of failing the build**, and the function degrades to titles without notations. Two things follow that are easy to forget: the key is embedded in the bundle uploaded to Contentful (`build/` is gitignored, so it stays out of git — but treat built artifacts as carrying a credential), and **rotating it requires a rebuild and re-upload**. It must also be authorized for the app's environment, not just `master`, or every concept read 404s.

There is no env-var alternative: a deployed Contentful Function has no environment-variable mechanism, and `context.cma` can't sidestep the key because app identity is space-scoped and cannot read org-level taxonomy. The only other channel is a Secret installation parameter, which was rejected so `.env` stays the single place the key is configured.

The **editor** needs the same key, because `sdk.cma` cannot read concepts at all (see "Where to look for X"). `vite.config.mts` widens Vite's `envPrefix` to `["VITE_", "CONTENTFUL_DELIVERY_KEY"]` — the key by its **exact full name**, so `.env` stays the single source and no `VITE_`-prefixed duplicate has to be kept in sync. Read it as `import.meta.env.CONTENTFUL_DELIVERY_KEY`; `src/vite-env.d.ts` declares the type. A missing key warns and drops notations from the title rather than breaking the editor.

**Never widen that list to a bare `CONTENTFUL_` prefix.** Everything matching it is inlined into the browser bundle Contentful serves to every viewer, and `CONTENTFUL_ACCESS_TOKEN` is a management PAT. After touching `envPrefix` or the esbuild `define` block, rebuild and grep `build/` to confirm the delivery key is present and the access token is not.

One thing is **not** inlined anywhere: the org id. The editor reads `sdk.ids.organization` from the SDK — don't add a define for it.

## Function deploy flow

- Function declared in `contentful-app-manifest.json` (`autoEntryTitleHandler`, type `appevent.handler`).
- After deploy, the App Event Subscription (9 topics → `autoEntryTitleHandler`) must be created manually once in the Contentful web UI — this is not automated by the manifest. The full nine-topic list is in `README.md` ("One-time setup").
- CMA read + write permissions on entries must be granted at the org-level App Definition settings (also not in the manifest).
- A Contentful App Definition supports only ONE `appevent.handler` function. That's why `functions/handler/index.ts` is a topic dispatcher rather than multiple handlers — do not split _it_ into separate function entry points.
- That cap does NOT apply to `appaction.call`. An App Definition may declare N of those, which is why `functions/handler/actions.ts` (concept-notation repair) is a legitimate second entry point with its own bundle. Both are built from `esbuild.functions.config.js`.
- App Actions are declared in the manifest's `actions[]` block and registered with `npm run upsert-actions`. Note that command **rewrites `contentful-app-manifest.json` in place** (stamps the remote action id, reformats the JSON) — that's `@contentful/app-scripts` behaviour; commit the resulting diff.

## Editor-side staleness

**Policy: the editor reads cross-entry state once, at mount, and does not chase updates.** `publicationDate` runs its CMA lookup in `subscribe` and holds the result in the fragment's slot for the session (it does _not_ cache — there is no cache in that file; the value simply isn't re-read). `conceptNotation` goes further and memoizes per scheme via `withConceptCache` in `src/fragments/concepts.ts` — the repo's only real cache, alongside the reader map in `Field.tsx` — never invalidated for the session. That reader map caches `undefined` too, so a missing-key warning fires once per space/environment rather than on every mount.

So if a Release is scheduled, or a concept's notation edited, in another tab, the editor won't reflect it until the entry is reopened. The server-side path corrects the persisted title and is authoritative. Don't add retry/refresh logic in the editor to "fix" this — it's intentional.

### Concepts are assigned on a different tab than the title — the app isn't mounted for it

Taxonomy concepts are assigned on the entry editor's **Taxonomy** tab, while this app renders as an `entry-field` widget on the **Editor** tab. The web app **unmounts the non-active tab's DOM**, so our iframe is destroyed while the editor is on Taxonomy. No `metadataChanged` message can reach a listener that doesn't exist, and the notation therefore updates on **tab switch back**, not at the moment a concept is added or removed.

This is a host lifecycle constraint, not a bug, and **there is nothing to fix in `conceptNotation`** — `onMetadataChanged` is a `MemoizedSignal`, so remounting replays the current metadata immediately, which is exactly why switching back applies the change. Don't "fix" the perceived lag by polling `getMetadata()` or subscribing to `onSysChanged`: the iframe isn't running, so no in-app subscription of any kind can observe a change made on another tab. The only real levers are host-side (a sidebar location, which is also unmounted, or Contentful keeping tabs mounted).

The consequence that *is* partly mitigated is **publishing from the Taxonomy tab**, which used to go live with a stale title and nothing to correct it. `handleLinkedEntryPublish` now recomputes the published entry's own title alongside its referencing parents — but as a **draft** write, so the entry lands in "Changed" state and a human must publish again. Deliberately not automated; see the blockquote under README "Expected: the title updates when you switch back to the Editor tab" and "### Recursion safety".

`src/locations/Field.integration.spec.tsx` covers everything downstream of a dispatch — add, remove, remove-the-last-one, re-add — so a genuine regression in that path fails a test rather than looking like this lifecycle behaviour.

## Fragment authoring contract

A fragment is the unit of composition. When adding one:

- Implement BOTH `subscribe` and `compute` on the `Fragment` interface. The editor uses `subscribe`; the propagation Function uses `compute`. Keep their outputs aligned or you'll see drift between live editor renders and server-driven recomputes.
- Emit `""` for "I have nothing to contribute right now" — `joinFragments` filters empties before joining, so an empty fragment doesn't leave a dangling separator.
- Emit `null` for **"I could not find out"** — a failed lookup, a missing credential, a capability that wasn't threaded through. This is NOT the same as `""` and the difference is load-bearing: `joinFragments` returns `null` for the whole title, and both write paths (`Field.tsx` `setValue`, `recomputeTitleForEntries`'s PATCH) skip the write entirely. Emitting `""` on failure produces a title that looks valid but is missing a piece, and persisting it **deletes real data** — that is exactly how a missing delivery key used to strip `MRRL` out of every title the editor opened or the Function touched. Warn, return `null`, leave the stored title alone.
- **Entries reaching `compute` must be CMA-fetched, never App Event body snapshots.** This is the same data-loss mode from the other direction, and it is not enforced anywhere. `conceptNotation.compute` reads `entry.metadata?.concepts`, and zero concept ids resolves to `""` — *not* `null` — so an entry without `metadata` composes a title **missing the notation blob**, passes the `null` guard, and gets PATCHed over the correct one. An App Event body is not guaranteed to carry `metadata`, and `FragmentComputeEntry` declares `metadata?` optional with no `sys.version` at all, so passing `event.body` straight through typechecks cleanly. No `functions/` fixture except `linkedEntryTitle.spec.ts`'s carries `metadata`, so this regression would pass the entire suite. Every dispatch path hydrates first: see the re-fetch in `functions/handler/linkedEntryTitle.ts` and the per-member hydration in `functions/handler/releaseDate.ts`.
- **Every `subscribe` path must emit something**, including its guard clauses. A slot that never emits stays `null` forever, so `Field.tsx` withholds the whole title — that's the intended behaviour for a pending async read, but a permanent condition like "this content type has no such field" is `""` ("nothing to contribute"), not silence. See the missing-field branches in `fieldValue.ts` / `referencedEntryTitle.ts`.
- Don't throw from `subscribe`. Catch and emit `""` or `null` per the distinction above. Failures inside a fragment must not break the join.
- `compute` may throw; `composeTitle` catches per-fragment failures and substitutes `""`. That fallback predates the `null` convention and is deliberately unchanged — a **throw** still degrades to an empty slot, so return `null` explicitly when you mean "don't write".
- New fragments register by being added to the `composition.fragments` array in `src/fragments/index.ts`.
- A fragment may read **`metadata`** as well as `fields`. Concepts live on `metadata.concepts`, which `onValueChanged` cannot observe — subscribe with `sdk.entry.getMetadata()` for the initial paint plus `sdk.entry.onMetadataChanged(cb)` for updates (see `conceptNotation`). `FragmentComputeEntry.metadata` is optional, because entries predating taxonomy have none.
- A fragment needing a capability beyond `FragmentCmaClient` takes it as its own **optional context key** rather than widening the CMA type — the `conceptReader` precedent. Widening `FragmentCmaClient` would stop `sdk.cma` satisfying it and break the invariant its own doc comment states.
- Optional context keys are a real tradeoff: a dispatch path that forgets to thread one through still compiles and still writes titles, just missing that fragment's contribution. So every new dispatch branch must forward them, and there should be a test asserting it (see `functions/handler/index.spec.ts`).
- If a fragment reads data that both phases must agree on, funnel both through **one pure function** and pin them with a parity test (`conceptNotation.spec.ts` has an `it.each` table asserting `subscribe`'s last emit equals `compute`'s return). This is the contract most likely to drift silently.
- **`npm run build` does not typecheck** — `vite build` and vitest both only transpile. Run `npx tsc --noEmit` before declaring fragment work done.

## Conventions

- TypeScript strict, React 18, functional components only.
- Prettier: `singleQuote: true`, `semi: true`, `printWidth: 80`, `trailingComma: 'es5'`, `arrowParens: 'avoid'`, 2-space indent, LF endings. ESLint extends `react-app` only — no custom rules.
- Commit messages are short imperative sentences ending in a period (e.g. `Add support for naming based off of Brand.`, `Update logic to support Release Delete and (Un)Archive.`). Match this style.
- Do not hand-edit `exports/space/export.json` — it's a regenerated snapshot artifact. If it needs updating, ask the user how they refresh it rather than patching it inline.
- The composition assumes the host content type has `brands`, `description`, and `regions` fields. There's no per-content-type configuration UI; if you need to support a content type with different field ids, edit `src/fragments/index.ts`. Out of scope to make this configurable until there's a second consumer with a different shape.

## Tests

Vitest. Mocks live in `test/mocks/`. The Contentful App SDK is mocked there — extend the existing mock rather than re-mocking inline when a new test needs SDK surface area. `src/fragments/testEmitter.ts` is the shared emitter helper for fragment specs; use it instead of hand-rolling a `vi.fn()` cast.

## Cross-stack gotchas

This repo has paid for a handful of Contentful-stack quirks that apply to any App Framework / Functions project. They live in `~/.claude/memory/` — consult them before guessing API shapes (e.g., scheduled-actions filter syntax, function runtime CMA construction, App SDK hook restrictions).

Two more established here, both worth checking before touching taxonomy: **there is no space-scoped CMA taxonomy route** (it 404s — use the org-scoped CMA or the env-scoped CDA `/taxonomy/concepts`, which paginates by cursor via `pages.next` with no `total`), and **no App Event topic fires on a taxonomy change**, which is why concept propagation is an App Action.
