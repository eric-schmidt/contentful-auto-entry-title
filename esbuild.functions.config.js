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

const appDefinitionId = process.env.CONTENTFUL_APP_DEF_ID;
if (!appDefinitionId) {
  throw new Error(
    "CONTENTFUL_APP_DEF_ID is required to build functions. " +
      "Set it in your shell or .env before running `npm run build:functions`.",
  );
}

module.exports = {
  entryPoints: { "functions/handler/index": "./functions/handler/index.ts" },
  bundle: true,
  outdir: "build",
  format: "esm",
  target: "es2022",
  minify: true,
  define: {
    global: "globalThis",
    __APP_DEFINITION_ID__: JSON.stringify(appDefinitionId),
  },
  logLevel: "info",
};
