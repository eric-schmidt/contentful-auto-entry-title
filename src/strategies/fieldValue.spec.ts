import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fieldValue } from "./fieldValue";

type Listener = (value: unknown) => void;

const buildSdk = (fieldId: string | null) => {
  const unsubscribe = vi.fn();
  let listener: Listener | null = null;
  const onValueChanged = vi.fn((cb: Listener) => {
    listener = cb;
    return unsubscribe;
  });

  const sdk = {
    entry: {
      fields: fieldId
        ? {
            [fieldId]: { id: fieldId, onValueChanged },
          }
        : ({} as Record<string, never>),
    },
  } as unknown as Parameters<ReturnType<typeof fieldValue>>[0]["sdk"];

  return {
    sdk,
    onValueChanged,
    unsubscribe,
    fire: (value: unknown) => listener?.(value),
  };
};

describe("fieldValue", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("emits the field value on initial subscription", () => {
    const { sdk, fire } = buildSdk("description");
    const emit = vi.fn();

    fieldValue({ fieldId: "description" })({ sdk, emit });
    fire("hello");

    expect(emit).toHaveBeenCalledWith("hello");
  });

  it("re-emits when the source field value changes", () => {
    const { sdk, fire } = buildSdk("description");
    const emit = vi.fn();

    fieldValue({ fieldId: "description" })({ sdk, emit });
    fire("hello");
    fire("world");

    expect(emit).toHaveBeenNthCalledWith(1, "hello");
    expect(emit).toHaveBeenNthCalledWith(2, "world");
  });

  it("coerces non-string values to empty string", () => {
    const { sdk, fire } = buildSdk("description");
    const emit = vi.fn();

    fieldValue({ fieldId: "description" })({ sdk, emit });
    fire(undefined);
    fire(null);
    fire(42);
    fire(true);

    expect(emit).toHaveBeenCalledTimes(4);
    expect(emit.mock.calls.every(([v]) => v === "")).toBe(true);
  });

  it("warns and no-ops when the field id is missing", () => {
    const { sdk, onValueChanged } = buildSdk(null);
    const emit = vi.fn();

    const teardown = fieldValue({ fieldId: "nope" })({ sdk, emit });

    expect(emit).not.toHaveBeenCalled();
    expect(onValueChanged).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
  });

  it("teardown invokes the onValueChanged unsubscribe", () => {
    const { sdk, unsubscribe } = buildSdk("description");
    const emit = vi.fn();

    const teardown = fieldValue({ fieldId: "description" })({ sdk, emit });
    teardown();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
