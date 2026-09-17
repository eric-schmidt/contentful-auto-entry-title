// Test helpers: the two module mocks every `Field.tsx` spec needs.
//
// `Field.tsx` pulls its SDK from `useSDK()` and renders a `SingleLineEditor`.
// Neither is usable under jsdom — the first expects the App SDK's iframe
// handshake, the second is a heavy Forma 36 tree irrelevant to what these specs
// assert — so both get replaced. Sharing them keeps the two specs' stubs from
// drifting: they previously carried separate `SingleLineEditor` fakes, and only
// one of them forwarded the disabled state.
//
// Lives in `src/` rather than `test/` on purpose: `tsconfig.json` includes only
// `src` and `functions`, so a helper under `test/` would be invisible to
// `npx tsc --noEmit` — the repo's only typecheck gate. Same reasoning as
// `src/fragments/testEmitter.ts`.
//
// Usage. Two hoisting hazards, both already paid for here:
//
//   1. The factories must be ASYNC and import this module inside themselves.
//      `vi.mock` calls are hoisted above every import, so a factory referencing
//      a statically-imported helper throws `Cannot access '__vi_import__' before
//      initialization` the moment the spec imports `Field` on line 1.
//   2. The SDK reaches the factory through this module's binding, not a
//      spec-level `let` — same hoisting reason. Specs call `setCurrentSdk` per
//      test.
//
//   vi.mock("@contentful/react-apps-toolkit", async () =>
//     (await import("./fieldEditorMocks")).reactAppsToolkitMock(),
//   );
//   vi.mock("@contentful/field-editor-single-line", async () =>
//     (await import("./fieldEditorMocks")).singleLineEditorMock(),
//   );
//   // ...then, inside each test:
//   setCurrentSdk(buildSdk());

import { vi } from "vitest";

let sdk: unknown;

// The SDK the mocked `useSDK()` will return. Each spec builds its own shape —
// they need different surface area — so this is deliberately untyped.
export const setCurrentSdk = (next: unknown): void => {
  sdk = next;
};

export const currentSdk = (): never => sdk as never;

// Replacement for `@contentful/react-apps-toolkit`. Only `useSDK` is stubbed;
// nothing in `Field.tsx` touches the rest of that module.
export const reactAppsToolkitMock = () => ({ useSDK: () => currentSdk() });

// Replacement for `@contentful/field-editor-single-line`, reduced to a marker
// div. `data-disabled` reflects the `isDisabled` prop `Field.tsx` actually
// passes, so a spec can assert the field renders read-only.
export const singleLineEditorMock = () => ({
  SingleLineEditor: (props: { isDisabled?: boolean }) => (
    <div
      data-test-id="single-line-editor"
      data-disabled={String(!!props.isDisabled)}
    />
  ),
});
