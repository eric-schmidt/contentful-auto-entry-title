import Field from "./Field";
import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { FragmentEmitter, Fragment } from "../fragments/types";

vi.mock("../fragments", () => {
  const noopEmitter = (): FragmentEmitter => {
    const fn = (() => {}) as unknown as FragmentEmitter;
    fn.skip = () => {};
    return fn;
  };

  const teardownA = vi.fn();
  const teardownB = vi.fn();
  const refs: {
    emitA: FragmentEmitter;
    emitB: FragmentEmitter;
  } = {
    emitA: noopEmitter(),
    emitB: noopEmitter(),
  };

  const fragmentA: Fragment = {
    subscribe: ({ emit }) => {
      refs.emitA = emit;
      return teardownA;
    },
    compute: async () => "",
  };
  const fragmentB: Fragment = {
    subscribe: ({ emit }) => {
      refs.emitB = emit;
      return teardownB;
    },
    compute: async () => "",
  };

  return {
    composition: {
      fragments: [fragmentA, fragmentB],
      separator: " - ",
    },
    __testRefs: refs,
    __teardownA: teardownA,
    __teardownB: teardownB,
    __noopEmitter: noopEmitter,
  };
});

import * as fragmentsModule from "../fragments";

const mocked = fragmentsModule as unknown as {
  __testRefs: { emitA: FragmentEmitter; emitB: FragmentEmitter };
  __teardownA: ReturnType<typeof vi.fn>;
  __teardownB: ReturnType<typeof vi.fn>;
  __noopEmitter: () => FragmentEmitter;
};

const buildSdk = (initialValue = "") => {
  let value = initialValue;
  const setValue = vi.fn((next: string) => {
    value = next;
  });
  const getValue = vi.fn(() => value);

  return {
    locales: { available: ["en-US"], default: "en-US" },
    field: {
      id: "title",
      locale: "en-US",
      getValue,
      setValue,
    },
    window: { startAutoResizer: vi.fn() },
  };
};

let currentSdk: ReturnType<typeof buildSdk>;
vi.mock("@contentful/react-apps-toolkit", () => ({
  useSDK: () => currentSdk,
}));

vi.mock("@contentful/field-editor-single-line", () => ({
  SingleLineEditor: (props: { isInitiallyDisabled?: boolean }) => (
    <div
      data-test-id="single-line-editor"
      data-disabled={String(!!props.isInitiallyDisabled)}
    />
  ),
}));

describe("Field component", () => {
  beforeEach(() => {
    mocked.__teardownA.mockReset();
    mocked.__teardownB.mockReset();
    mocked.__testRefs.emitA = mocked.__noopEmitter();
    mocked.__testRefs.emitB = mocked.__noopEmitter();
  });

  it("renders the disabled SingleLineEditor and starts the auto-resizer", () => {
    currentSdk = buildSdk();

    render(<Field />);

    const editor = screen.getByTestId("single-line-editor");
    expect(editor).toHaveAttribute("data-disabled", "true");
    expect(currentSdk.window.startAutoResizer).toHaveBeenCalled();
  });

  it("composes fragment emits with the configured separator and writes via sdk.field.setValue", () => {
    currentSdk = buildSdk();

    render(<Field />);

    mocked.__testRefs.emitA("A");
    mocked.__testRefs.emitB("B");

    expect(currentSdk.field.setValue).toHaveBeenLastCalledWith("A - B");

    mocked.__testRefs.emitB("C");
    expect(currentSdk.field.setValue).toHaveBeenLastCalledWith("A - C");
  });

  it("omits empty fragments from the joined output (no orphan separators)", () => {
    currentSdk = buildSdk();

    render(<Field />);

    mocked.__testRefs.emitA("A");

    expect(currentSdk.field.setValue).toHaveBeenLastCalledWith("A");

    mocked.__testRefs.emitB("B");
    expect(currentSdk.field.setValue).toHaveBeenLastCalledWith("A - B");
  });

  it("skips setValue when a re-emit produces the same composed value", () => {
    currentSdk = buildSdk();

    render(<Field />);

    mocked.__testRefs.emitA("A");
    mocked.__testRefs.emitB("B");

    const writesAfterInitial = currentSdk.field.setValue.mock.calls.length;
    expect(currentSdk.field.setValue).toHaveBeenLastCalledWith("A - B");

    mocked.__testRefs.emitA("A");
    mocked.__testRefs.emitB("B");

    expect(currentSdk.field.setValue.mock.calls.length).toBe(writesAfterInitial);
  });

  it("does not write to the field while any slot is in the skip state", () => {
    currentSdk = buildSdk("preserved-by-function");

    render(<Field />);

    mocked.__testRefs.emitA.skip();
    mocked.__testRefs.emitB("B");

    expect(currentSdk.field.setValue).not.toHaveBeenCalled();
  });

  it("resumes writing once a skipped slot emits a string value", () => {
    currentSdk = buildSdk();

    render(<Field />);

    mocked.__testRefs.emitA.skip();
    mocked.__testRefs.emitB("B");
    expect(currentSdk.field.setValue).not.toHaveBeenCalled();

    mocked.__testRefs.emitA("A");
    expect(currentSdk.field.setValue).toHaveBeenLastCalledWith("A - B");
  });

  it("invokes every fragment teardown on unmount", () => {
    currentSdk = buildSdk();

    const { unmount } = render(<Field />);
    unmount();

    expect(mocked.__teardownA).toHaveBeenCalledTimes(1);
    expect(mocked.__teardownB).toHaveBeenCalledTimes(1);
  });
});
