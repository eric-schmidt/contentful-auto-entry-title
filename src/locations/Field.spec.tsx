import Field from "./Field";
import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { FragmentEmitter, FragmentStrategy } from "../strategies/types";

vi.mock("../strategies", () => {
  const teardownA = vi.fn();
  const teardownB = vi.fn();
  const refs: {
    emitA: FragmentEmitter;
    emitB: FragmentEmitter;
  } = {
    emitA: () => {},
    emitB: () => {},
  };

  const fragmentA: FragmentStrategy = ({ emit }) => {
    refs.emitA = emit;
    return teardownA;
  };
  const fragmentB: FragmentStrategy = ({ emit }) => {
    refs.emitB = emit;
    return teardownB;
  };

  return {
    composition: {
      fragments: [fragmentA, fragmentB],
      separator: " - ",
    },
    __testRefs: refs,
    __teardownA: teardownA,
    __teardownB: teardownB,
  };
});

import * as strategiesModule from "../strategies";

const mocked = strategiesModule as unknown as {
  __testRefs: { emitA: FragmentEmitter; emitB: FragmentEmitter };
  __teardownA: ReturnType<typeof vi.fn>;
  __teardownB: ReturnType<typeof vi.fn>;
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
    mocked.__testRefs.emitA = () => {};
    mocked.__testRefs.emitB = () => {};
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

  it("invokes every fragment teardown on unmount", () => {
    currentSdk = buildSdk();

    const { unmount } = render(<Field />);
    unmount();

    expect(mocked.__teardownA).toHaveBeenCalledTimes(1);
    expect(mocked.__teardownB).toHaveBeenCalledTimes(1);
  });
});
