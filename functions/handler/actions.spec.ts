import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

vi.mock("../../src/fragments", () => ({
  composition: { fragments: [], separator: " - " },
}));

vi.mock("../../src/fragments/compose", () => ({
  composeTitle: vi.fn(async () => "2026 - MRRL - pdpPage"),
  joinFragments: (fragments: string[], sep?: string) =>
    fragments.filter((s) => s !== "").join(sep ?? ""),
}));

import { handler } from "./actions";
import { composeTitle } from "../../src/fragments/compose";

const APP_DEF_ID = "test-app-def-id";
const NEW_TITLE = "2026 - MRRL - pdpPage";

beforeAll(() => {
  (globalThis as { __APP_DEFINITION_ID__?: string }).__APP_DEFINITION_ID__ =
    APP_DEF_ID;
});

const buildEntry = ({
  id,
  currentTitle = "old",
  contentTypeId = "pdpPage",
  version = 1,
}: {
  id: string;
  currentTitle?: string;
  contentTypeId?: string;
  version?: number;
}) => ({
  sys: { id, version, contentType: { sys: { id: contentTypeId } } },
  fields: { internalTitle: { "en-US": currentTitle } },
});

const managedControls = {
  controls: [
    {
      fieldId: "internalTitle",
      widgetNamespace: "app",
      widgetId: APP_DEF_ID,
    },
  ],
};

const buildContext = ({
  entries = [] as ReturnType<typeof buildEntry>[],
  total,
  editorInterfaces = { pdpPage: managedControls } as Record<string, unknown>,
}: {
  entries?: ReturnType<typeof buildEntry>[];
  total?: number;
  editorInterfaces?: Record<string, unknown>;
} = {}) => {
  const patch = vi.fn(async ({ entryId }: { entryId: string }) => ({
    sys: { id: entryId, version: 2 },
    fields: {},
  }));
  const getMany = vi.fn(async ({ query }: { query: { skip: number } }) => ({
    items: query.skip === 0 ? entries : [],
    total: total ?? entries.length,
  }));
  const publish = vi.fn();

  const context = {
    cma: {
      locale: {
        getMany: vi.fn(async () => ({
          items: [{ code: "en-US", default: true }],
        })),
      },
      // `publish` is here only to be asserted never-called: this path writes
      // drafts, which emit `Entry.save`, and the dispatcher routes only
      // `Entry.publish` / `Release.*` / `ScheduledAction.*`. Publishing would
      // feed our own writes back into the handler.
      entry: { getMany, patch, publish },
      editorInterface: {
        get: vi.fn(async ({ contentTypeId }: { contentTypeId: string }) => {
          const ei = editorInterfaces[contentTypeId];
          if (!ei) throw new Error("not found");
          return ei;
        }),
      },
    },
    spaceId: "space-1",
    environmentId: "taxonomy",
  };

  return { context: context as never, patch, getMany, publish };
};

const invoke = (conceptIds: string | undefined, ctx: { context: never }) =>
  handler({ body: { conceptIds } }, ctx.context);

// The delivery key arrives as a build-time inlined global, not as an
// installation parameter — see functions/shared/conceptReaderForFunction.ts.
// esbuild's `define` doesn't run under vitest, so tests stub the global. Empty
// string is what a build with no key set produces.
const withDeliveryKey = (key: string) => {
  vi.stubGlobal("__DELIVERY_KEY__", key);
};

describe("conceptNotation app action", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(composeTitle).mockClear();
    withDeliveryKey("delivery-key");
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("does nothing when conceptIds is absent", async () => {
    const ctx = buildContext();
    const result = await invoke(undefined, ctx);

    expect(result).toEqual({ conceptIds: [], entriesConsidered: 0 });
    expect(ctx.getMany).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("does nothing when conceptIds is only whitespace and commas", async () => {
    const ctx = buildContext();
    const result = await invoke(" , ,, ", ctx);

    expect(result.conceptIds).toEqual([]);
    expect(ctx.getMany).not.toHaveBeenCalled();
  });

  it("trims and dedupes ids, querying the concept reverse index", async () => {
    const ctx = buildContext({
      entries: [buildEntry({ id: "e1" })],
    });

    const result = await invoke(" mens , doubleRl ,mens", ctx);

    expect(result.conceptIds).toEqual(["mens", "doubleRl"]);
    expect(ctx.getMany).toHaveBeenCalledWith({
      query: {
        "metadata.concepts.sys.id[in]": "mens,doubleRl",
        skip: 0,
        limit: 100,
      },
    });
  });

  it("patches the recomputed title on managed entries", async () => {
    const ctx = buildContext({
      entries: [buildEntry({ id: "e1", version: 7 })],
    });

    await invoke("doubleRl", ctx);

    expect(ctx.patch).toHaveBeenCalledTimes(1);
    expect(ctx.patch).toHaveBeenCalledWith({ entryId: "e1", version: 7 }, [
      {
        op: "add",
        path: "/fields/internalTitle/en-US",
        value: NEW_TITLE,
      },
    ]);
  });

  it("skips entries whose title field isn't bound to this app", async () => {
    const ctx = buildContext({
      entries: [
        buildEntry({ id: "managed" }),
        buildEntry({ id: "unmanaged", contentTypeId: "campaign" }),
      ],
      editorInterfaces: { pdpPage: managedControls, campaign: { controls: [] } },
    });

    await invoke("doubleRl", ctx);

    expect(ctx.patch).toHaveBeenCalledTimes(1);
    expect(ctx.patch).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "managed" }),
      expect.anything(),
    );
  });

  it("is idempotent — a rerun with unchanged titles writes nothing", async () => {
    const ctx = buildContext({
      entries: [buildEntry({ id: "e1", currentTitle: NEW_TITLE })],
    });

    await invoke("doubleRl", ctx);

    expect(ctx.patch).not.toHaveBeenCalled();
  });

  it("paginates at 100 entries per page", async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      buildEntry({ id: `e${i}` }),
    );
    const patch = vi.fn(async ({ entryId }: { entryId: string }) => ({
      sys: { id: entryId, version: 2 },
      fields: {},
    }));
    let call = 0;
    const getMany = vi.fn(async () => {
      call += 1;
      return {
        items: call === 1 ? first : [buildEntry({ id: "e100" })],
        total: 101,
      };
    });
    const context = {
      cma: {
        locale: {
          getMany: vi.fn(async () => ({
            items: [{ code: "en-US", default: true }],
          })),
        },
        entry: { getMany, patch },
        editorInterface: { get: vi.fn(async () => managedControls) },
      },
      spaceId: "space-1",
      environmentId: "taxonomy",
    };

    const result = await handler(
      { body: { conceptIds: "doubleRl" } },
      context as never,
    );

    expect(getMany).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(101);
    expect(result.entriesConsidered).toBe(101);
  });

  it("retries a 429 on a patch and still updates the entry", async () => {
    // The whole point of functions/shared/rateLimit.ts: neither `context.cma`
    // nor `sdk.cma` inherits the SDK's own 429 retry, because both are
    // `apiAdapter` clients that bypass its axios interceptor.
    const ctx = buildContext({ entries: [buildEntry({ id: "e1" })] });
    const rateLimited = new Error(
      JSON.stringify({ status: 429, message: "rate limit" }),
    ) as Error & {
      response: { status: number; headers: Record<string, string> };
    };
    rateLimited.name = "RateLimitExceeded";
    // Zero-second reset keeps the real sleep short; the ~500ms floor still
    // applies, so this test tolerates a little real time rather than juggling
    // fake timers through the whole handler.
    rateLimited.response = {
      status: 429,
      headers: { "x-contentful-ratelimit-reset": "0" },
    };
    ctx.patch.mockRejectedValueOnce(rateLimited);

    const result = await invoke("doubleRl", ctx);

    expect(ctx.patch).toHaveBeenCalledTimes(2);
    expect(result.updated).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("reports counts so a caller can tell a clean run from a failed one", async () => {
    const ctx = buildContext({
      entries: [
        buildEntry({ id: "e1" }),
        // Title already correct, so it is skipped rather than patched.
        buildEntry({ id: "e2", currentTitle: NEW_TITLE }),
        buildEntry({ id: "e3" }),
      ],
    });
    ctx.patch.mockRejectedValueOnce(new Error("boom"));

    const result = await invoke("doubleRl", ctx);

    expect(result.entriesConsidered).toBe(3);
    expect(result.skipped).toBe(1);
    // One of the two patch-eligible entries fails; concurrency means which one
    // is not deterministic, so assert the split rather than the identity.
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(1);
  });

  it("continues the batch when one entry's patch fails", async () => {
    const ctx = buildContext({
      entries: [buildEntry({ id: "e1" }), buildEntry({ id: "e2" })],
    });
    ctx.patch
      .mockRejectedValueOnce(new Error("version mismatch"))
      .mockResolvedValueOnce({ sys: { id: "e2", version: 2 }, fields: {} });

    await invoke("doubleRl", ctx);

    expect(ctx.patch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("warns and writes nothing when no delivery key was inlined", async () => {
    // Recomputing without a concept reader would strip the notation from every
    // title it touched — strictly worse than leaving stale titles in place.
    withDeliveryKey("");
    const ctx = buildContext({
      entries: [buildEntry({ id: "e1" })],
    });

    const result = await invoke("doubleRl", ctx);

    expect(result).toEqual({
      conceptIds: ["doubleRl"],
      entriesConsidered: 0,
    });
    expect(ctx.getMany).not.toHaveBeenCalled();
    expect(ctx.patch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no delivery key was inlined"),
    );
  });

  it("passes a concept reader into the recompute so notations survive", async () => {
    const ctx = buildContext({ entries: [buildEntry({ id: "e1" })] });

    await invoke("doubleRl", ctx);

    expect(composeTitle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conceptReader: expect.any(Function) }),
    );
  });

  it("never publishes — the repair corrects drafts only", async () => {
    const ctx = buildContext({ entries: [buildEntry({ id: "e1" })] });

    await invoke("doubleRl", ctx);

    expect(ctx.patch).toHaveBeenCalled();
    expect(ctx.publish).not.toHaveBeenCalled();
  });
});
