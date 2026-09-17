import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createCdaConceptReader,
  notationForSchemes,
  resolveConceptNotation,
  withConceptCache,
  type SchemeConcepts,
} from "./concepts";
import type { ConceptRecord } from "./types";

const concept = (id: string, ...notations: string[]): ConceptRecord => ({
  id,
  notations,
});

const DIVISION: ConceptRecord[] = [concept("mens", "M"), concept("womens", "W")];
const BRAND: ConceptRecord[] = [
  concept("polo", "Polo"),
  concept("rl", "RL"),
  concept("rlx", "RLX"),
  concept("lauren", "L"),
  concept("doubleRl", "RRL"),
];
const SEASON: ConceptRecord[] = [concept("spring", "SP")];

const schemes = (
  ...entries: [string, ConceptRecord[]][]
): SchemeConcepts[] =>
  entries.map(([schemeId, concepts]) => ({ schemeId, concepts }));

const divisionThenBrand = schemes(["division", DIVISION], ["brand", BRAND]);

describe("notationForSchemes", () => {
  it("concatenates division then brand notations", () => {
    expect(notationForSchemes(["mens", "doubleRl"], divisionThenBrand)).toBe(
      "MRRL",
    );
  });

  it("is independent of the order concept ids arrive in", () => {
    expect(notationForSchemes(["doubleRl", "mens"], divisionThenBrand)).toBe(
      "MRRL",
    );
  });

  it("follows the scheme order given, not the concept order", () => {
    const brandThenDivision = schemes(["brand", BRAND], ["division", DIVISION]);
    expect(notationForSchemes(["mens", "doubleRl"], brandThenDivision)).toBe(
      "RRLM",
    );
  });

  it("sorts multiple concepts within one scheme", () => {
    // "RL" sorts before "RRL", regardless of the order in the id list.
    expect(notationForSchemes(["doubleRl", "rl"], divisionThenBrand)).toBe(
      "RLRRL",
    );
  });

  it("concatenates a concept's own notations in sorted order", () => {
    const multi = schemes(["division", [concept("both", "B", "A")]]);
    expect(notationForSchemes(["both"], multi)).toBe("AB");
  });

  it("ignores concepts belonging to no listed scheme", () => {
    // `spring` is a real concept on the entry, but `season` isn't composed —
    // it must not leak into the blob.
    expect(SEASON.map((c) => c.id)).toContain("spring");
    expect(
      notationForSchemes(["mens", "spring", "doubleRl"], divisionThenBrand),
    ).toBe("MRRL");
  });

  it("contributes nothing for a concept with no notations", () => {
    const blank = schemes(["division", [concept("mens"), concept("womens", "W")]]);
    expect(notationForSchemes(["mens", "womens"], blank)).toBe("W");
  });

  it("skips empty-string notations", () => {
    const blank = schemes(["division", [concept("mens", "", "M")]]);
    expect(notationForSchemes(["mens"], blank)).toBe("M");
  });

  it("returns empty string for no concepts", () => {
    expect(notationForSchemes([], divisionThenBrand)).toBe("");
  });

  it("returns empty string when no concept id matches a scheme", () => {
    expect(notationForSchemes(["unknown"], divisionThenBrand)).toBe("");
  });
});

describe("resolveConceptNotation", () => {
  it("reads each scheme once and joins in schemeIds order", async () => {
    const reader = vi.fn(async (schemeId: string) =>
      schemeId === "division" ? DIVISION : BRAND,
    );

    const result = await resolveConceptNotation({
      conceptIds: ["doubleRl", "mens"],
      schemeIds: ["division", "brand"],
      reader,
    });

    expect(result).toBe("MRRL");
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenCalledWith("division");
    expect(reader).toHaveBeenCalledWith("brand");
  });

  it("short-circuits without reading when the entry has no concepts", async () => {
    const reader = vi.fn(async () => DIVISION);

    const result = await resolveConceptNotation({
      conceptIds: [],
      schemeIds: ["division"],
      reader,
    });

    expect(result).toBe("");
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects when a scheme read fails", async () => {
    const reader = vi.fn(async () => {
      throw new Error("404");
    });

    await expect(
      resolveConceptNotation({
        conceptIds: ["mens"],
        schemeIds: ["division"],
        reader,
      }),
    ).rejects.toThrow("404");
  });
});

describe("createCdaConceptReader", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const cdaPayload = (items: ConceptRecord[], next?: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      items: items.map((c) => ({
        sys: { id: c.id, type: "TaxonomyConcept" },
        notations: c.notations,
      })),
      ...(next ? { pages: { next } } : {}),
    }),
  });

  const buildReader = () =>
    createCdaConceptReader({
      spaceId: "space-1",
      environmentId: "taxonomy",
      deliveryKey: "delivery-key",
    });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the env-scoped taxonomy route with a bearer delivery key", async () => {
    fetchMock.mockResolvedValueOnce(cdaPayload(DIVISION));

    const result = await buildReader()("division");

    expect(result).toEqual([
      { id: "mens", notations: ["M"] },
      { id: "womens", notations: ["W"] },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(
      "https://cdn.contentful.com/spaces/space-1/environments/taxonomy/taxonomy/concepts",
    );
    expect(url).toContain("conceptScheme=division");
    expect(init.headers.Authorization).toBe("Bearer delivery-key");
  });

  it("follows pages.next until it is absent", async () => {
    fetchMock
      .mockResolvedValueOnce(
        cdaPayload([concept("polo", "Polo")], "/spaces/space-1/page2"),
      )
      .mockResolvedValueOnce(cdaPayload([concept("rl", "RL")]));

    const result = await buildReader()("brand");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://cdn.contentful.com/spaces/space-1/page2",
    );
    expect(result.map((c) => c.id)).toEqual(["polo", "rl"]);
  });

  it("stops at the page cap rather than looping on a self-referential cursor", async () => {
    fetchMock.mockResolvedValue(
      cdaPayload([concept("polo", "Polo")], "https://cdn.contentful.com/loop"),
    );

    const result = await buildReader()("brand");

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(result).toHaveLength(20);
  });

  it("rejects on a non-2xx response, naming the likely cause of a 404", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(buildReader()("division")).rejects.toThrow(
      /404.*not authorized for environment "taxonomy"/s,
    );
  });

  it("drops items without a sys.id rather than emitting undefined ids", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ notations: ["X"] }, { sys: { id: "mens" }, notations: ["M"] }],
      }),
    });

    const result = await buildReader()("division");

    expect(result).toEqual([{ id: "mens", notations: ["M"] }]);
  });

  it("defaults notations to an empty array when the field is absent", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ sys: { id: "mens" } }] }),
    });

    expect(await buildReader()("division")).toEqual([
      { id: "mens", notations: [] },
    ]);
  });
});

describe("withConceptCache", () => {
  it("fetches a scheme once across repeated calls", async () => {
    const reader = vi.fn(async () => DIVISION);
    const cached = withConceptCache(reader);

    await cached("division");
    await cached("division");
    await cached("division");

    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent calls into a single in-flight request", async () => {
    let resolveRead: (records: ConceptRecord[]) => void = () => {};
    const reader = vi.fn(
      () =>
        new Promise<ConceptRecord[]>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const cached = withConceptCache(reader);

    const both = Promise.all([cached("division"), cached("division")]);
    resolveRead(DIVISION);

    expect(await both).toEqual([DIVISION, DIVISION]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("caches per scheme, not globally", async () => {
    const reader = vi.fn(async (schemeId: string) =>
      schemeId === "division" ? DIVISION : BRAND,
    );
    const cached = withConceptCache(reader);

    expect(await cached("division")).toEqual(DIVISION);
    expect(await cached("brand")).toEqual(BRAND);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("never re-reads a resolved scheme — the deliberate staleness policy", async () => {
    let call = 0;
    const reader = vi.fn(async () => {
      call += 1;
      return [concept("mens", call === 1 ? "M" : "CHANGED")];
    });
    const cached = withConceptCache(reader);

    expect(await cached("division")).toEqual([{ id: "mens", notations: ["M"] }]);
    // A notation edited elsewhere is NOT picked up for the life of the session.
    expect(await cached("division")).toEqual([{ id: "mens", notations: ["M"] }]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejection so a transient failure doesn't poison the scheme", async () => {
    const reader = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(DIVISION);
    const cached = withConceptCache(reader);

    await expect(cached("division")).rejects.toThrow("network");
    expect(await cached("division")).toEqual(DIVISION);
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
