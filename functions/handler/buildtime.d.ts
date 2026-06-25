// Build-time constants injected by esbuild.functions.config.js (`define`).
// At runtime in the deployed function bundle, these are inlined string literals.
// In tests / typecheck against source, they're declared globals — tests should
// stub them via vi.stubGlobal where they assert against the value.
declare const __APP_DEFINITION_ID__: string;
