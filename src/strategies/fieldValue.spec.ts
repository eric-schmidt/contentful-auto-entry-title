import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fieldValue } from "./fieldValue";
import { mockEmitter } from "./testEmitter";

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
  } as unknown as Parameters<ReturnType<typeof fieldValue>["subscribe"]>[0]["sdk"];

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

  describe("subscribe", () => {
    it("emits the field value on initial subscription", () => {
      const { sdk, fire } = buildSdk("description");
      const emit = mockEmitter();

      fieldValue({ fieldId: "description" }).subscribe({ sdk, emit });
      fire("hello");

      expect(emit).toHaveBeenCalledWith("hello");
    });

    it("re-emits when the source field value changes", () => {
      const { sdk, fire } = buildSdk("description");
      const emit = mockEmitter();

      fieldValue({ fieldId: "description" }).subscribe({ sdk, emit });
      fire("hello");
      fire("world");

      expect(emit).toHaveBeenNthCalledWith(1, "hello");
      expect(emit).toHaveBeenNthCalledWith(2, "world");
    });

    it("coerces non-string values to empty string", () => {
      const { sdk, fire } = buildSdk("description");
      const emit = mockEmitter();

      fieldValue({ fieldId: "description" }).subscribe({ sdk, emit });
      fire(undefined);
      fire(null);
      fire(42);
      fire(true);

      expect(emit).toHaveBeenCalledTimes(4);
      expect(emit.mock.calls.every(([v]) => v === "")).toBe(true);
    });

    it("warns and no-ops when the field id is missing", () => {
      const { sdk, onValueChanged } = buildSdk(null);
      const emit = mockEmitter();

      const teardown = fieldValue({ fieldId: "nope" }).subscribe({ sdk, emit });

      expect(emit).not.toHaveBeenCalled();
      expect(onValueChanged).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(typeof teardown).toBe("function");
      expect(() => teardown()).not.toThrow();
    });

    it("teardown invokes the onValueChanged unsubscribe", () => {
      const { sdk, unsubscribe } = buildSdk("description");
      const emit = mockEmitter();

      const teardown = fieldValue({ fieldId: "description" }).subscribe({ sdk, emit });
      teardown();

      expect(unsubscribe).toHaveBeenCalledOnce();
    });
  });

  describe("compute", () => {
    const buildEntry = (description: unknown) =>
      ({
        sys: { id: "e1", contentType: { sys: { id: "blogPost" } } },
        fields: { description: { "en-US": description } },
      }) as never;

    it("reads the field value at the default locale", async () => {
      const result = await fieldValue({ fieldId: "description" }).compute({
        entry: buildEntry("hello"),
        cma: {} as never,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("hello");
    });

    it("returns empty string when the field is missing or non-string", async () => {
      const strat = fieldValue({ fieldId: "description" });

      expect(
        await strat.compute({
          entry: { sys: { id: "e1", contentType: { sys: { id: "blogPost" } } }, fields: {} } as never,
          cma: {} as never,
          defaultLocale: "en-US",
          environmentId: "master",
        }),
      ).toBe("");

      expect(
        await strat.compute({
          entry: buildEntry(42),
          cma: {} as never,
          defaultLocale: "en-US",
          environmentId: "master",
        }),
      ).toBe("");
    });
  });
});
