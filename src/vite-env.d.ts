// Vite's client types, which declare `import.meta.env`. Needed because
// src/fragments/conceptReaderBrowser.ts reads the delivery key from it — see
// the `envPrefix` entry in vite.config.mts.
//
// `npm run build` does not typecheck (vite only transpiles), so without this the
// break shows up only under `npx tsc --noEmit`.
/// <reference types="vite/client" />

// Narrows the delivery key specifically, so a typo in the variable name is a
// compile error rather than a silently-undefined read at runtime.
interface ImportMetaEnv {
  readonly CONTENTFUL_DELIVERY_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
