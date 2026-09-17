import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { conceptNotation } from "./conceptNotation";
import { mockEmitter } from "./testEmitter";
import type { ConceptReader, ConceptRecord } from "./types";

const SCHEME_IDS = ["division", "brand"];

const concept = (id: string, ...notations: string[]): ConceptRecord => ({
  id,
  notations,
});

const CONCEPTS_BY_SCHEME: Record<string, ConceptRecord[]> = {
  division: [concept("mens", "M"), concept("womens", "W")],
  brand: [concept("doubleRl", "RRL"), concept("rl", "RL")],
  season: [concept("spring", "SP")],
};

const stubReader = (): ConceptReader =>
  vi.fn(async (schemeId: string) => CONCEPTS_BY_SCHEME[schemeId] ?? []);

const conceptLinks = (ids: string[]) =>
  ids.map((id) => ({
    sys: { type: "Link" as const, linkType: "TaxonomyConcept" as const, id },
  }));

type MetadataListener = (metadata?: unknown) => void;

const buildSdk = (conceptIds: string[] | null) => {
  const unsubscribe = vi.fn();
  let listener: MetadataListener | null = null;

  const metadata =
    conceptIds === null
      ? undefined
      : { tags: [], concepts: conceptLinks(conceptIds) };

  const sdk = {
    entry: {
      fields: {},
      getMetadata: vi.fn(() => metadata),
      onMetadataChanged: vi.fn((cb: MetadataListener) => {
        listener = cb;
        return unsubscribe;
      }),
    },
    locales: { default: "en-US" },
  } as unknown as Parameters<
    ReturnType<typeof conceptNotation>["subscribe"]
  >[0]["sdk"];

  return {
    sdk,
    unsubscribe,
    fire: (ids: string[] | null) =>
      listener?.(
        ids === null ? undefined : { tags: [], concepts: conceptLinks(ids) },
      ),
  };
};

const buildEntry = (conceptIds: string[] | null) =>
  ({
    sys: { id: "p1", contentType: { sys: { id: "pdpPage" } } },
    fields: {},
    ...(conceptIds === null
      ? {}
      : { metadata: { tags: [], concepts: conceptLinks(conceptIds) } }),
  }) as never;

const computeWith = (
  conceptIds: string[] | null,
  conceptReader?: ConceptReader,
) =>
  conceptNotation({ schemeIds: SCHEME_IDS }).compute({
    entry: buildEntry(conceptIds),
    cma: {} as never,
    defaultLocale: "en-US",
    environmentId: "taxonomy",
    conceptReader,
  });

// `subscribe` resolves asynchronously inside a `.then`, so a spec has to let
// the microtask queue drain before asserting on `emit`.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("conceptNotation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("subscribe", () => {
    it("emits the notation blob from the initial getMetadata()", async () => {
      const { sdk } = buildSdk(["mens", "doubleRl"]);
      const emit = mockEmitter();

      conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
        sdk,
        emit,
        conceptReader: stubReader(),
      });
      await flush();

      expect(emit).toHaveBeenCalledWith("MRRL");
    });

    it("re-emits when onMetadataChanged fires", async () => {
      const { sdk, fire } = buildSdk(["mens"]);
      const emit = mockEmitter();

      conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
        sdk,
        emit,
        conceptReader: stubReader(),
      });
      await flush();
      expect(emit).toHaveBeenLastCalledWith("M");

      fire(["mens", "doubleRl"]);
      await flush();
      expect(emit).toHaveBeenLastCalledWith("MRRL");
    });

    // Removal is NOT symmetric with addition as far as coverage goes: the add
    // path was verified live while removal was not, so it gets its own cases.
    // Both shortenings have to reach `emit` for the title to shrink — a
    // fragment that only ever grows its contribution would look fine on every
    // add and silently keep a stale notation on every remove.
    it("re-emits a shorter blob when one concept is removed", async () => {
      const { sdk, fire } = buildSdk(["mens", "doubleRl"]);
      const emit = mockEmitter();

      conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
        sdk,
        emit,
        conceptReader: stubReader(),
      });
      await flush();
      expect(emit).toHaveBeenLastCalledWith("MRRL");

      fire(["mens"]);
      await flush();
      expect(emit).toHaveBeenLastCalledWith("M");
    });

    // The edge of the removal path: emptying `concepts` entirely must emit ""
    // ("nothing to contribute"), NOT null. `null` would withhold the write and
    // leave the last concept's notation stranded in the stored title forever.
    it("emits empty string when the last concept is removed", async () => {
      const { sdk, fire } = buildSdk(["mens"]);
      const emit = mockEmitter();

      conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
        sdk,
        emit,
        conceptReader: stubReader(),
      });
      await flush();
      expect(emit).toHaveBeenLastCalledWith("M");

      fire([]);
      await flush();
      expect(emit).toHaveBeenLastCalledWith("");
    });

    it("emits empty string when the entry has no metadata at all", async () => {
      const { sdk } = buildSdk(null);
      const emit = mockEmitter();
      const reader = stubReader();

      conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
        sdk,
        emit,
        conceptReader: reader,
      });
      await flush();

      expect(emit).toHaveBeenCalledWith("");
      expect(reader).not.toHaveBeenCalled();
    });

    it("emits empty string when metadata carries no concepts", async () => {
      const { sdk } = buildSdk([]);
      const emit = mockEmitter();

      conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
        sdk,
        emit,
        conceptReader: stubReader(),
      });
      await flush();

      expect(emit).toHaveBeenCalledWith("");
    });

    // `null`, not "": the entry HAS concepts, so the notation is unknown rather
    // than absent. Emitting "" would compose a title without the blob, which
    // the editor then autosaves over the correct stored one.
    it("emits null (not empty) and warns when the reader rejects", async () => {
      const { sdk } = buildSdk(["mens"]);
      const emit = mockEmitter();
      const failing: ConceptReader = vi.fn(async () => {
        throw new Error("404");
      });

      conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
        sdk,
        emit,
        conceptReader: failing,
      });
      await flush();

      expect(emit).toHaveBeenCalledWith(null);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("emits null (not empty) and warns when no reader was threaded through", async () => {
      const { sdk } = buildSdk(["mens"]);
      const emit = mockEmitter();

      conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({ sdk, emit });
      await flush();

      expect(emit).toHaveBeenCalledWith(null);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no conceptReader in context"),
      );
    });

    it("does not throw when the reader rejects synchronously on subscribe", () => {
      const { sdk } = buildSdk(["mens"]);
      const emit = mockEmitter();
      const throwing: ConceptReader = vi.fn(() => {
        throw new Error("boom");
      });

      expect(() =>
        conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
          sdk,
          emit,
          conceptReader: throwing,
        }),
      ).not.toThrow();
    });

    it("teardown unsubscribes and suppresses a late emit", async () => {
      const { sdk, unsubscribe } = buildSdk(["mens"]);
      const emit = mockEmitter();
      let release: (records: ConceptRecord[]) => void = () => {};
      const slow: ConceptReader = () =>
        new Promise((resolve) => {
          release = resolve;
        });

      const teardown = conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
        sdk,
        emit,
        conceptReader: slow,
      });
      teardown();
      release([concept("mens", "M")]);
      await flush();

      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe("compute", () => {
    it("reads concept ids from entry.metadata.concepts", async () => {
      expect(await computeWith(["mens", "doubleRl"], stubReader())).toBe("MRRL");
    });

    it("returns empty string for an entry with no metadata", async () => {
      // Proves the optional `metadata` widening is safe for pre-taxonomy
      // entries — every Entry.publish recompute passes through here.
      const reader = stubReader();
      expect(await computeWith(null, reader)).toBe("");
      expect(reader).not.toHaveBeenCalled();
    });

    // Returning "" here is what used to make a keyless Function PATCH the
    // notation out of every entry in a fan-out. `null` makes the recompute loop
    // skip the entry instead.
    it("returns null and warns when conceptReader is absent", async () => {
      expect(await computeWith(["mens"])).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no conceptReader in context"),
      );
    });

    it("returns null and warns when the reader rejects", async () => {
      const failing: ConceptReader = vi.fn(async () => {
        throw new Error("404");
      });

      expect(await computeWith(["mens"], failing)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  // The two-phase contract is the thing most likely to drift silently: the
  // editor renders through `subscribe`, the propagation Function through
  // `compute`, and a divergence shows up as a title that changes on its own
  // after a publish. This pins them to each other over the interesting shapes.
  describe("subscribe/compute parity", () => {
    const cases: [name: string, conceptIds: string[] | null][] = [
      ["no metadata", null],
      ["no concepts", []],
      ["division only", ["mens"]],
      ["brand only", ["doubleRl"]],
      ["division + brand", ["mens", "doubleRl"]],
      ["reversed order", ["doubleRl", "mens"]],
      ["with excluded season concept", ["mens", "spring", "doubleRl"]],
      ["two brands", ["rl", "doubleRl"]],
      ["unresolvable id", ["mens", "not-a-concept"]],
    ];

    it.each(cases)("agrees for %s", async (_name, conceptIds) => {
      const reader = stubReader();
      const { sdk } = buildSdk(conceptIds);
      const emit = mockEmitter();

      conceptNotation({ schemeIds: SCHEME_IDS }).subscribe({
        sdk,
        emit,
        conceptReader: reader,
      });
      await flush();

      const subscribed = emit.mock.calls.at(-1)?.[0];
      const computed = await computeWith(conceptIds, reader);

      expect(subscribed).toBe(computed);
    });
  });
});
