# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Contentful App Framework field editor (React + Vite + TypeScript) that auto-generates entry titles by composing ordered fragments. Server-side propagation of cross-entry renames and release-schedule changes runs as a Contentful Function (`functions/handler/`).

Node version is pinned to v22 in `.nvmrc`. The CI workflow currently hardcodes Node 16.x — flag this if you touch the workflow.

## Commands

- `npm run dev` — Vite dev server on localhost:3000
- `npm run build` — builds the Vite app **and** bundles the function (`build:functions`)
- `npm run test:ci` — vitest run-once mode. **Use this before declaring work done; `npm test` is watch mode.**
- `npm run upload` — interactive upload of `build/` to Contentful
- `npm run upload-ci` — non-interactive upload (uses `CONTENTFUL_ORG_ID`, `CONTENTFUL_APP_DEF_ID`, `CONTENTFUL_ACCESS_TOKEN`)

## Where to look for X

When a non-obvious question comes up, the answer usually lives in a doc comment in the file below — read it before guessing.

- **How a fragment works / how to add one** → `src/fragments/types.ts` (the `Fragment` interface and its two-phase contract), then any existing fragment as a worked example.
- **Why `subscribe` and `compute` both exist on every fragment** → `src/fragments/publicationDate.ts` header comment. Short version: `subscribe` runs in the editor, `compute` runs in the Function, and both must agree.
- **What gets concatenated and how** → `src/fragments/compose.ts` (`joinFragments` filters out empty strings before joining).
- **What the current composition is** → `src/fragments/index.ts`. This is the only place to edit ordering / fragment choice. Field IDs (`brands`, `description`, `regions`) are hardcoded here.
- **Why the App Definition ID is a build-time global** → `functions/shared/findManagedTitleFieldId.ts` header. The function runtime doesn't expose it, so we `define` it via esbuild.
- **Why our esbuild config skips Node polyfills** → `esbuild.functions.config.js` header. Including them silently breaks the Functions runtime.
- **Why we use `context.cma` and not a fresh CMA client** → `functions/handler/index.ts` (`FunctionContext` comment). Building our own throws `Unknown adapter 'fetch'`.
- **Release / ScheduledAction event dispatch logic** → `functions/handler/releaseDate.ts` header on `handleReleaseOrScheduledActionEvent`. Member resolution differs across delete vs. save/archive vs. ScheduledAction.
- **Why ScheduledActions queries use `entity.sys.id` (singular) and one request per release id** → `src/fragments/publicationDate.ts` (`fetchMatchingScheduledActions` comment). The `[in]` filter is silently ignored by the CMA.
- **Why there's a retry loop on schedule lookups** → `src/fragments/publicationDate.ts` (`SCHEDULE_LOOKUP_RETRY_DELAYS_MS`) and `functions/handler/releaseDate.ts` (`RELEASE_FETCH_RETRY_DELAYS_MS`). Release.save fires before the ScheduledAction / release-member state is fully queryable.
- **Why the field is rendered disabled but not via a field-level disable** → `src/locations/Field.tsx` inline comment. Contentful does not let you UI-disable a title field; field-level perms are the only path.

## Build-time env var

`CONTENTFUL_APP_DEF_ID` must be set when running `build:functions` — `esbuild.functions.config.js` inlines it as the `__APP_DEFINITION_ID__` global. Build fails explicitly if missing. Any code that needs the app definition ID at function runtime should read `__APP_DEFINITION_ID__`, not `process.env`. In tests, stub via `vi.stubGlobal`.

## Function deploy flow

- Function declared in `contentful-app-manifest.json` (`autoEntryTitleHandler`, type `appevent.handler`).
- After deploy, the App Event Subscription (9 topics → `autoEntryTitleHandler`) must be created manually once in the Contentful web UI — this is not automated by the manifest. The full nine-topic list is in `README.md` ("One-time setup").
- CMA read + write permissions on entries must be granted at the org-level App Definition settings (also not in the manifest).
- A Contentful App Definition supports only ONE App Event handler function. That's why `functions/handler/index.ts` is a topic dispatcher rather than multiple handlers — do not split it into separate function entry points.

## Editor-side staleness

The `publicationDate` fragment caches CMA lookups in-memory. If a Release is scheduled in another tab, the editor won't reflect it until the entry is reopened. The server-side function corrects this on next save. Don't add retry/refresh logic in the editor to "fix" this — it's intentional, and the server-side path is authoritative.

## Known limitation worth preserving

Removing an entry from a Release is not detected by the event subscription (no diff in `Release.save`). The title self-heals when the entry is reopened. Don't paper over this with editor-side polling.

## Fragment authoring contract

A fragment is the unit of composition. When adding one:

- Implement BOTH `subscribe` and `compute` on the `Fragment` interface. The editor uses `subscribe`; the propagation Function uses `compute`. Keep their outputs aligned or you'll see drift between live editor renders and server-driven recomputes.
- Emit `""` for "I have nothing to contribute right now" — `joinFragments` filters empties before joining, so an empty fragment doesn't leave a dangling separator.
- Don't throw from `subscribe`. Catch and emit `""`. Failures inside a fragment must not break the join.
- `compute` may throw; `composeTitle` catches per-fragment failures and substitutes `""`. Still, prefer explicit catch + `""` for clarity.
- New fragments register by being added to the `composition.fragments` array in `src/fragments/index.ts`.

## Conventions

- TypeScript strict, React 18, functional components only.
- Prettier: `singleQuote: true`, `semi: true`, `printWidth: 80`, `trailingComma: 'es5'`, `arrowParens: 'avoid'`, 2-space indent, LF endings. ESLint extends `react-app` only — no custom rules.
- Commit messages are short imperative sentences ending in a period (e.g. `Add support for naming based off of Brand.`, `Update logic to support Release Delete and (Un)Archive.`). Match this style.
- Do not hand-edit `space-export.json` — it's a regenerated snapshot artifact. If it needs updating, ask the user how they refresh it rather than patching it inline.
- The composition assumes the host content type has `brands`, `description`, and `regions` fields. There's no per-content-type configuration UI; if you need to support a content type with different field ids, edit `src/fragments/index.ts`. Out of scope to make this configurable until there's a second consumer with a different shape.

## Tests

Vitest. Mocks live in `test/mocks/`. The Contentful App SDK is mocked there — extend the existing mock rather than re-mocking inline when a new test needs SDK surface area. `src/fragments/testEmitter.ts` is the shared emitter helper for fragment specs; use it instead of hand-rolling a `vi.fn()` cast.

## Cross-stack gotchas

This repo has paid for a handful of Contentful-stack quirks that apply to any App Framework / Functions project. They live in `~/.claude/memory/` — consult them before guessing API shapes (e.g., scheduled-actions filter syntax, function runtime CMA construction, App SDK hook restrictions).
