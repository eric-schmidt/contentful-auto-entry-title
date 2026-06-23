import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { referencedEntryTitle } from "./referencedEntryTitle";
import { mockEmitter } from "./testEmitter";

type Listener = (value: unknown) => void;

const buildLink = (id: string) => ({
  sys: { type: "Link", linkType: "Entry", id },
});

const buildSdk = (fieldId: string | null) => {
  const unsubscribe = vi.fn();
  let listener: Listener | null = null;
  const onValueChanged = vi.fn((cb: Listener) => {
    listener = cb;
    return unsubscribe;
  });

  const cmaGet = vi.fn();
  const sdk = {
    entry: {
      fields: fieldId
        ? {
            [fieldId]: { id: fieldId, onValueChanged },
          }
        : ({} as Record<string, never>),
    },
    cma: {
      entry: { get: cmaGet },
    },
    locales: { default: "en-US" },
  } as unknown as Parameters<
    ReturnType<typeof referencedEntryTitle>["subscribe"]
  >[0]["sdk"];

  return {
    sdk,
    cmaGet,
    unsubscribe,
    fire: async (value: unknown) => {
      await listener?.(value);
    },
  };
};

describe("referencedEntryTitle", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("subscribe", () => {
    it("emits the linked entry's title for a single link", async () => {
      const { sdk, cmaGet, fire } = buildSdk("regions");
      cmaGet.mockResolvedValueOnce({ fields: { title: { "en-US": "EMEA" } } });
      const emit = mockEmitter();

      referencedEntryTitle({ fieldId: "regions" }).subscribe({ sdk, emit });
      await fire(buildLink("region-1"));

      expect(cmaGet).toHaveBeenCalledWith({ entryId: "region-1" });
      expect(emit).toHaveBeenCalledWith("EMEA");
    });

    it("emits empty string when the value is undefined", async () => {
      const { sdk, cmaGet, fire } = buildSdk("regions");
      const emit = mockEmitter();

      referencedEntryTitle({ fieldId: "regions" }).subscribe({ sdk, emit });
      await fire(undefined);

      expect(cmaGet).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledWith("");
    });

    it("slash-joins all linked entry titles when value is an array of links", async () => {
      const { sdk, cmaGet, fire } = buildSdk("regions");
      cmaGet
        .mockResolvedValueOnce({ fields: { title: { "en-US": "EMEA" } } })
        .mockResolvedValueOnce({ fields: { title: { "en-US": "APAC" } } });
      const emit = mockEmitter();

      referencedEntryTitle({ fieldId: "regions" }).subscribe({ sdk, emit });
      await fire([buildLink("r1"), buildLink("r2")]);

      expect(emit).toHaveBeenCalledWith("EMEA/APAC");
    });

    it("drops failed fetches from the joined result", async () => {
      const { sdk, cmaGet, fire } = buildSdk("regions");
      cmaGet
        .mockResolvedValueOnce({ fields: { title: { "en-US": "EMEA" } } })
        .mockRejectedValueOnce(new Error("404"))
        .mockResolvedValueOnce({ fields: { title: { "en-US": "APAC" } } });
      const emit = mockEmitter();

      referencedEntryTitle({ fieldId: "regions" }).subscribe({ sdk, emit });
      await fire([buildLink("r1"), buildLink("missing"), buildLink("r2")]);

      expect(emit).toHaveBeenCalledWith("EMEA/APAC");
      expect(warnSpy).toHaveBeenCalled();
    });

    it("warns and emits empty string when the linked entry fetch fails", async () => {
      const { sdk, cmaGet, fire } = buildSdk("regions");
      cmaGet.mockRejectedValueOnce(new Error("404"));
      const emit = mockEmitter();

      referencedEntryTitle({ fieldId: "regions" }).subscribe({ sdk, emit });
      await fire(buildLink("missing"));

      expect(emit).toHaveBeenCalledWith("");
      expect(warnSpy).toHaveBeenCalled();
    });

    it("warns and no-ops when the field id is missing", () => {
      const { sdk } = buildSdk(null);
      const emit = mockEmitter();

      const teardown = referencedEntryTitle({ fieldId: "nope" }).subscribe({ sdk, emit });

      expect(emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(typeof teardown).toBe("function");
      expect(() => teardown()).not.toThrow();
    });

    it("teardown invokes the onValueChanged unsubscribe", () => {
      const { sdk, unsubscribe } = buildSdk("regions");
      const emit = mockEmitter();

      const teardown = referencedEntryTitle({ fieldId: "regions" }).subscribe({ sdk, emit });
      teardown();

      expect(unsubscribe).toHaveBeenCalledOnce();
    });
  });

  describe("compute", () => {
    const buildEntry = (regions: unknown) =>
      ({
        sys: { id: "p1", contentType: { sys: { id: "blogPost" } } },
        fields: { regions: { "en-US": regions } },
      }) as never;

    it("returns the linked entry's title", async () => {
      const cma = {
        entry: {
          get: vi.fn(async () => ({ fields: { title: { "en-US": "EMEA" } } })),
        },
      } as never;

      const result = await referencedEntryTitle({ fieldId: "regions" }).compute({
        entry: buildEntry(buildLink("r1")),
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("EMEA");
    });

    it("returns empty string when the field is unset", async () => {
      const cma = {
        entry: { get: vi.fn() },
      } as never;

      const result = await referencedEntryTitle({ fieldId: "regions" }).compute({
        entry: { sys: { id: "p1", contentType: { sys: { id: "blogPost" } } }, fields: {} } as never,
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("");
    });

    it("slash-joins all linked entry titles for multi-link fields", async () => {
      const get = vi
        .fn()
        .mockResolvedValueOnce({ fields: { title: { "en-US": "EMEA" } } })
        .mockResolvedValueOnce({ fields: { title: { "en-US": "APAC" } } });
      const cma = { entry: { get } } as never;

      const result = await referencedEntryTitle({ fieldId: "regions" }).compute({
        entry: buildEntry([buildLink("r1"), buildLink("r2")]),
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("EMEA/APAC");
    });
  });
});
