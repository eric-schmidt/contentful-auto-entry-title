import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `envPrefix` is widened from Vite's default (`VITE_`) to ALSO expose
// `CONTENTFUL_DELIVERY_KEY` under its canonical name, so `.env` stays the single
// place the key is configured — no duplicate `VITE_`-prefixed copy to keep in
// sync, and the same variable the function build reads.
//
// This is a deliberate, narrow exposure: EVERY var matching a listed prefix is
// inlined into the browser bundle Contentful serves. `CONTENTFUL_DELIVERY_KEY`
// is read-only and space-scoped, which is what makes it acceptable — the same
// way CDA keys are used in any browser app.
//
// DANGER: do NOT add a bare `CONTENTFUL_` prefix here. That would sweep in
// `CONTENTFUL_ACCESS_TOKEN` — a management PAT — and publish it to every
// visitor. The prefixes below are exact, full variable names for that reason.
export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_", "CONTENTFUL_DELIVERY_KEY"],
  test: {
    globals: true, // Enables Jest-like global test functions (test, expect)
    environment: 'jsdom', // Simulates a browser for component tests
    setupFiles: './src/setupTests.ts', // Equivalent to Jest's setup file
  },
  base: '',
  build: {
    outDir: 'build',
  },
  server: {
    host: 'localhost',
    port: 3000,
  },
});
