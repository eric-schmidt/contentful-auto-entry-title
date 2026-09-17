// Build-time constants injected by esbuild.functions.config.js (`define`).
// At runtime in the deployed function bundle, these are inlined string literals.
// In tests / typecheck against source, they're declared globals — tests should
// stub them via vi.stubGlobal where they assert against the value.
declare const __APP_DEFINITION_ID__: string;

// The Content Delivery API key used for taxonomy reads at function runtime.
// Inlined from `CONTENTFUL_DELIVERY_KEY` so `.env` is the single place it is
// configured — a deployed Function has no env-var mechanism to read it from.
// Empty string when the build had no key set; callers must treat that as
// "no taxonomy reads available" rather than assuming a value.
declare const __DELIVERY_KEY__: string;
