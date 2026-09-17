import { describe, it, expect, vi, afterEach } from "vitest";
import type { PlainClientAPI } from "contentful-management";
import { paginateEntries, PAGE_SIZE } from "./paginateEntries";

const entries = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, i) => ({
    sys: { id: `e${offset + i}` },
  }));

// A CMA stub that serves `count` entries out of a single flat list, paging on
// the `skip`/`limit` it is handed. `total` is included unless overridden, so a
// test can drop it to exercise the non-numeric guard.
const buildCma = (count: number, opts: { withTotal?: boolean } = {}) => {
  const all = entries(count);
  const getMany = vi.fn(async ({ query }: { query: Record<string, unknown> }) => {
    const skip = query.skip as number;
    const limit = query.limit as number;
    return {
      items: all.slice(skip, skip + limit),
      skip,
      limit,
      ...(opts.withTotal === false ? {} : { total: count }),
    };
  });
  return { cma: { entry: { getMany } } as unknown as PlainClientAPI, getMany };
};

describe("paginateEntries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a single short page in one request", async () => {
    const { cma, getMany } = buildCma(7);

    const result = await paginateEntries(cma, { links_to_entry: "x" }, "spec");

    expect(result).toHaveLength(7);
    expect(getMany).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array for no matches", async () => {
    const { cma, getMany } = buildCma(0);

    expect(
      await paginateEntries(cma, { links_to_entry: "x" }, "spec"),
    ).toEqual([]);
    expect(getMany).toHaveBeenCalledTimes(1);
  });

  it("walks multiple pages and concatenates them in order", async () => {
    const { cma, getMany } = buildCma(PAGE_SIZE * 2 + 5);

    const result = await paginateEntries(cma, { links_to_entry: "x" }, "spec");

    expect(result).toHaveLength(PAGE_SIZE * 2 + 5);
    expect(result[0].sys.id).toBe("e0");
    expect(result[result.length - 1].sys.id).toBe(`e${PAGE_SIZE * 2 + 4}`);
    expect(getMany).toHaveBeenCalledTimes(3);
  });

  // An exact multiple can't be detected by the short-page check, so `total` is
  // what stops the loop. Without it there'd be one wasted empty request.
  it("stops on total when the last page is exactly full", async () => {
    const { cma, getMany } = buildCma(PAGE_SIZE * 2);

    const result = await paginateEntries(cma, { links_to_entry: "x" }, "spec");

    expect(result).toHaveLength(PAGE_SIZE * 2);
    expect(getMany).toHaveBeenCalledTimes(2);
  });

  // The bug the extraction fixed: `skip >= undefined` is false, so the old
  // loops re-requested the same page forever. The short-page check now
  // terminates regardless of `total`.
  it("terminates when the response omits total", async () => {
    const { cma, getMany } = buildCma(PAGE_SIZE + 3, { withTotal: false });

    const result = await paginateEntries(cma, { links_to_entry: "x" }, "spec");

    expect(result).toHaveLength(PAGE_SIZE + 3);
    expect(getMany).toHaveBeenCalledTimes(2);
  });

  it("caps pagination and warns rather than looping forever", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Every page is full and `total` never runs out, so only the cap can stop
    // this — the shape a malformed response would produce.
    const getMany = vi.fn(async ({ query }: { query: Record<string, unknown> }) => ({
      items: entries(query.limit as number),
      total: Number.MAX_SAFE_INTEGER,
    }));
    const cma = { entry: { getMany } } as unknown as PlainClientAPI;

    const result = await paginateEntries(cma, { links_to_entry: "x" }, "spec");

    expect(getMany).toHaveBeenCalledTimes(100);
    expect(result).toHaveLength(100 * PAGE_SIZE);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("stopped paginating at 100 pages"),
    );
  });

  it("passes the caller's query through and owns skip/limit", async () => {
    const { cma, getMany } = buildCma(1);

    await paginateEntries(
      cma,
      { "metadata.concepts.sys.id[in]": "a,b" },
      "spec",
    );

    expect(getMany).toHaveBeenCalledWith({
      query: {
        "metadata.concepts.sys.id[in]": "a,b",
        skip: 0,
        limit: PAGE_SIZE,
      },
    });
  });
});
