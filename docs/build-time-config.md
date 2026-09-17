# Build-time configuration

Two values reach the deployed Contentful Function as **string literals inlined
by esbuild at build time**, not as configuration:

| Global                  | Source env var            | Missing at build time         |
| ----------------------- | ------------------------- | ----------------------------- |
| `__APP_DEFINITION_ID__` | `CONTENTFUL_APP_DEF_ID`   | **Build fails**               |
| `__DELIVERY_KEY__`      | `CONTENTFUL_DELIVERY_KEY` | Build **warns** and continues |

> **This is the one piece of non-obvious build complexity in the repo.** Skip it
> and the function deploys successfully but **silently updates zero entries**.
> Read this before touching `esbuild.functions.config.js`,
> `functions/handler/buildtime.d.ts`, or the `build:functions` npm script.

## Why inlining at all

A **deployed Contentful Function has no environment-variable mechanism.** `.env`
is a local build artifact and never reaches the function runtime, and the
function context exposes `cmaClientOptions`, `spaceId`, `environmentId` and a
few other things — but no app identity and no credentials. The only two channels
for a build-independent value are an esbuild `define` and a Secret installation
parameter.

The define was chosen both times so that **`.env` is the single place either
value is configured**, with no config screen to keep in sync.

## `CONTENTFUL_APP_DEF_ID` → `__APP_DEFINITION_ID__`

The function needs its own App Definition ID at runtime to identify which
entries' title fields are bound to this app:

```ts
editorInterface.controls.find(
  c => c.widgetNamespace === 'app' && c.widgetId === __APP_DEFINITION_ID__
);
```

When a content modeler configures a field to use a custom app, Contentful writes
the **App Definition ID** into `editorInterface.controls[].widgetId`. Without
that comparison the function cannot scope its writes to fields this app manages
— it would touch every app-managed title field in the space, potentially
clobbering another app's.

Three options were considered for sourcing it:

1. **Build-time inlining via esbuild `define`** (chosen). Self-contained bundle,
   no per-install configuration, no runtime cost. Cost: one small config file,
   and the build requires the env var.
2. **`appInstallationParameters` via a config screen.** More flexible for
   multi-customer reuse, but adds runtime UI surface area for a value that is
   effectively a constant of this build.
3. **Match on `widgetNamespace === "app"` alone.** Simplest, but risks writing
   to unrelated apps' title fields.

For this app's shape — one bundle, one App Definition — option 1 is the lowest
total complexity. If it is ever distributed as a reusable marketplace app,
option 2 becomes the right move.

## `CONTENTFUL_DELIVERY_KEY` → `__DELIVERY_KEY__`

Needed because taxonomy concepts are unreachable through app identity — see
[Taxonomy notation](./taxonomy-notation.md#where-taxonomy-actually-lives-the-scoping-table).
Unlike the app definition id, a missing key **warns instead of failing the
build**: the editor and the function then have no concept reader, `conceptNotation`
returns `null`, and **titles stop being updated at all** rather than being
rewritten without their notation. That is the safe failure, and it is
[explained in full there](./taxonomy-notation.md#failure-behaviour).

Two consequences that are easy to forget:

- The key is **embedded in the bundle uploaded to Contentful**. `build/` is
  gitignored so it stays out of version control, but **treat built artifacts as
  carrying a credential**. The key is read-only and space-scoped, which bounds
  the exposure.
- **Rotating the key requires a rebuild and re-upload.** Changing it in
  Contentful alone does not update the deployed function.

It must also be **authorized for every environment the app is installed in**,
not just `master`, or every concept read returns 404.

### The editor needs the same key

`sdk.cma` cannot read concepts either, so the browser bundle reads the CDA
directly. `vite.config.mts` widens Vite's `envPrefix` to
`["VITE_", "CONTENTFUL_DELIVERY_KEY"]` — the key **by its exact full name**, so
`.env` stays the single source and no `VITE_`-prefixed duplicate has to be kept
in sync. Read it as `import.meta.env.CONTENTFUL_DELIVERY_KEY`;
`src/vite-env.d.ts` declares the type.

> **Never widen that list to a bare `CONTENTFUL_` prefix.** Everything matching
> it is inlined into the browser bundle Contentful serves to every viewer, and
> `CONTENTFUL_ACCESS_TOKEN` is a management PAT. After touching `envPrefix` or
> the esbuild `define` block, rebuild and grep `build/` to confirm the delivery
> key is present and the access token is not.

## How it fits together

| File                                           | Role                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `esbuild.functions.config.js`                  | Reads both env vars and `define`s them as the two globals.                                         |
| `functions/handler/buildtime.d.ts`             | `declare const` for both, so TypeScript and editors recognize them.                                |
| `functions/shared/findManagedTitleFieldId.ts`  | Uses `__APP_DEFINITION_ID__` in the editor-interface match.                                        |
| `functions/shared/conceptReaderForFunction.ts` | Reads `__DELIVERY_KEY__` defensively and builds the reader.                                        |
| `package.json` (`build:functions`)             | Passes `--esbuild-config esbuild.functions.config.js` to `contentful-app-scripts build-functions`. |

Both function entry points (`functions/handler/index.ts` and
`functions/handler/actions.ts`) are built from this one config and both receive
the defines.

## Operational notes

- **If you change which App Definition the bundle is built for**, rebuild and
  re-upload. The id is baked in.
- **Tests** stub the globals with `vi.stubGlobal` (see
  `functions/handler/linkedEntryTitle.spec.ts` and `index.spec.ts`), because
  esbuild's `define` does not run under vitest.
- The **org id is not inlined** — the editor reads `sdk.ids.organization` from
  the SDK. Don't add a define for it.
- **`npm run build` does not typecheck.** `vite build` and vitest both only
  transpile; `npx tsc --noEmit` is the only type gate.
