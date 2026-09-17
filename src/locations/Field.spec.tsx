import Field from "./Field";
import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { FragmentEmitter, Fragment } from "../fragments/types";

vi.mock("../fragments", () => {
  const teardownA = vi.fn();
  const teardownB = vi.fn();
  const refs: {
    emitA: FragmentEmitter;
    emitB: FragmentEmitter;
  } = {
    emitA: () => {},
    emitB: () => {},
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
  };
});

import * as fragmentsModule from "../fragments";

const mocked = fragmentsModule as unknown as {
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
    // Field.tsx builds a concept reader keyed by space+environment and backed
    // by cmaAdapter. The reader is lazy — nothing is requested until a
    // fragment calls it, and `../fragments` is mocked here — so these only
    // need to exist, not to work.
    ids: { space: "test-space", environment: "master", organization: "test-org" },
    cmaAdapter: { makeRequest: vi.fn() },
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

  it("renders the SingleLineEditor and starts the auto-resizer", () => {
    currentSdk = buildSdk();

    render(<Field />);

    expect(screen.getByTestId("single-line-editor")).toBeInTheDocument();
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

    // Both slots must report before anything is written — see the
    // withholding test below — so "" is how a slot says "nothing here".
    mocked.__testRefs.emitA("A");
    mocked.__testRefs.emitB("");

    expect(currentSdk.field.setValue).toHaveBeenLastCalledWith("A");

    mocked.__testRefs.emitB("B");
    expect(currentSdk.field.setValue).toHaveBeenLastCalledWith("A - B");
  });

  // The clobber guard. A fragment that hasn't answered yet, or that reports
  // `null` because it couldn't find out (a failed taxonomy read), must not
  // produce a shortened title — the web app autosaves whatever lands here, so
  // writing it would delete the notation from a title the server got right.
  it("withholds the write until every fragment has reported", () => {
    currentSdk = buildSdk("2026 - MRRL - stored");

    render(<Field />);

    mocked.__testRefs.emitA("A");

    expect(currentSdk.field.setValue).not.toHaveBeenCalled();
    expect(currentSdk.field.getValue()).toBe("2026 - MRRL - stored");

    mocked.__testRefs.emitB("B");
    expect(currentSdk.field.setValue).toHaveBeenLastCalledWith("A - B");
  });

  it("withholds the write when a fragment reports an unknown value", () => {
    currentSdk = buildSdk("2026 - MRRL - stored");

    render(<Field />);

    mocked.__testRefs.emitA("A");
    mocked.__testRefs.emitB(null);

    expect(currentSdk.field.setValue).not.toHaveBeenCalled();
    expect(currentSdk.field.getValue()).toBe("2026 - MRRL - stored");

    // ...and recovers once the value becomes known.
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
