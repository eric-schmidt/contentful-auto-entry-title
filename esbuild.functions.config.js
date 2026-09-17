// Custom esbuild config for `contentful-app-scripts build-functions`.
// We use our own config (rather than the default the CLI synthesizes) so we
// can `define` build-time constants — specifically the App Definition ID,
// which the function context does NOT inject at runtime but which we need
// to match against `editorInterface.controls[].widgetId`.
//
// `process.env.CONTENTFUL_APP_DEF_ID` is read here (build time) and inlined
// into the function bundle as a string literal.
//
// IMPORTANT — no Node polyfills. The default config that
// `contentful-app-scripts` synthesizes includes `NodeModulesPolyfillPlugin`
// and `NodeGlobalsPolyfillPlugin` for compatibility with apps that pull in
// Node-only dependencies. Including those polyfills here injects a
// `process`/`setTimeout` polyfill at the top of the bundle that throws
// during module-load in the Contentful Functions runtime, suppressing every
// log line and making the handler appear silent for some event topics.
//
// Our function uses only platform-provided APIs (`fetch`, `setTimeout`,
// `console`) and `context.cma` (a runtime-provided plain CMA client). No
// Node-only imports. Skipping the polyfills produces a smaller, faster
// bundle that loads cleanly.
//
// Two entry points, not one: the one-per-App-Definition cap applies only to
// `appevent.handler` (functions/handler/index.ts). `appaction.call` functions
// are unrestricted, so the concept-notation repair action is its own bundle.
//
// `CONTENTFUL_DELIVERY_KEY` is inlined here too, as `__DELIVERY_KEY__`. This is
// a deliberate, explicit tradeoff, chosen so that `.env` is the single place the
// key is configured:
//
//   - A deployed Contentful Function runs on Contentful's infrastructure and
//     has NO environment-variable mechanism. `.env` is a local build artifact
//     and never reaches the function runtime. The only two channels that exist
//     are this build-time inline and a Secret installation parameter.
//   - `context.cma` can't sidestep the key: it acts as the app identity, which
//     is scoped to a single space environment and cannot read org-level
//     taxonomy. There is no space-scoped CMA taxonomy route at all.
//
// Consequences to be aware of, since they are real:
//   - The key is embedded in the bundle uploaded to Contentful. `build/` is
//     gitignored, so it does not enter version control, but treat built
//     artifacts as containing a credential.
//   - ROTATING THE KEY REQUIRES A REBUILD AND RE-UPLOAD. Changing it in
//     Contentful alone will not update the deployed function.
// The key is read-only and space-scoped, which bounds the exposure.
//
// Where the values come from: `contentful-app-scripts build-functions` loads
// `.env` itself (via dotenvx — it prints "injected env (N) from .env") BEFORE
// requiring this config, so `process.env` is already populated here. Nothing in
// this file needs to read `.env`. dotenvx does not clobber variables that are
// already exported, so a shell value or CI secret still wins over the file.
//
// Unlike the app definition id, a missing delivery key does NOT fail the build:
// the editor path doesn't need it (it proxies through `sdk.cmaAdapter` as the
// signed-in user), and the function degrades to titles without notations rather
// than not building. It warns instead.

const appDefinitionId = process.env.CONTENTFUL_APP_DEF_ID;
if (!appDefinitionId) {
  throw new Error(
    "CONTENTFUL_APP_DEF_ID is required to build functions. " +
      "Set it in your shell or .env before running `npm run build:functions`.",
  );
}

const deliveryKey = process.env.CONTENTFUL_DELIVERY_KEY ?? "";
if (!deliveryKey) {
  console.warn(
    "[auto-entry-title] CONTENTFUL_DELIVERY_KEY is not set. Building anyway, " +
      "but the deployed function will omit taxonomy notations from every " +
      "title it rewrites. Set it in .env and rebuild.",
  );
}

module.exports = {
  entryPoints: {
    "functions/handler/index": "./functions/handler/index.ts",
    "functions/handler/actions": "./functions/handler/actions.ts",
  },
  bundle: true,
  outdir: "build",
  format: "esm",
  target: "es2022",
  minify: true,
  define: {
    global: "globalThis",
    __APP_DEFINITION_ID__: JSON.stringify(appDefinitionId),
    __DELIVERY_KEY__: JSON.stringify(deliveryKey),
  },
  logLevel: "info",
};
