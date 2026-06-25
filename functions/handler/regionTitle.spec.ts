import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

vi.mock("../../src/fragments", () => ({
  composition: {
    fragments: [],
    separator: " - ",
  },
}));

vi.mock("../../src/fragments/compose", () => ({
  composeTitle: vi.fn(async () => "EMEA - blogPost"),
  joinFragments: (fragments: string[], sep?: string) =>
    fragments.filter((s) => s !== "").join(sep ?? ""),
}));

import { handleRegionPublish } from "./regionTitle";
import { composeTitle } from "../../src/fragments/compose";

const APP_DEF_ID = "test-app-def-id";

beforeAll(() => {
  // The function code references the build-time-injected `__APP_DEFINITION_ID__`
  // global; in tests we stub it onto globalThis.
  (globalThis as { __APP_DEFINITION_ID__?: string }).__APP_DEFINITION_ID__ = APP_DEF_ID;
});

const buildSourceEntry = (overrides: { contentTypeId?: string; entryId?: string } = {}) => ({
  sys: {
    id: overrides.entryId ?? "region-1",
    contentType: { sys: { id: overrides.contentTypeId ?? "region" } },
  },
  fields: {},
});

const buildParent = (overrides: {
  id: string;
  contentTypeId: string;
  titleFieldId?: string;
  currentTitle?: string;
  version?: number;
}) => ({
  sys: {
    id: overrides.id,
    version: overrides.version ?? 1,
    contentType: { sys: { id: overrides.contentTypeId } },
  },
  fields: overrides.titleFieldId
    ? {
        [overrides.titleFieldId]: { "en-US": overrides.currentTitle ?? "" },
      }
    : {},
});

const defaultPatch = vi.fn(async ({ entryId }: { entryId: string }, _ops) => ({
  sys: { id: entryId, version: 2 },
  fields: { internalTitle: { "en-US": "EMEA - blogPost" } },
}));

const buildArgs = (
  parents: ReturnType<typeof buildParent>[],
  editorInterfaces: Record<
    string,
    { controls?: { fieldId: string; widgetNamespace: string; widgetId: string }[] }
  >,
) => {
  const patch = vi.fn(async ({ entryId }: { entryId: string }, _ops) => ({
    sys: { id: entryId, version: 2 },
    fields: { internalTitle: { "en-US": "EMEA - blogPost" } },
  }));
  const cma = {
    locale: {
      getMany: vi.fn(async () => ({
        items: [{ code: "en-US", default: true }],
      })),
    },
    entry: {
      getMany: vi.fn(async ({ query }: { query: { skip: number } }) => ({
        items: query.skip === 0 ? parents : [],
        total: parents.length,
      })),
      patch,
    },
    editorInterface: {
      get: vi.fn(async ({ contentTypeId }: { contentTypeId: string }) => {
        const ei = editorInterfaces[contentTypeId];
        if (!ei) throw new Error("not found");
        return ei;
      }),
    },
  };
  return { cma, environmentId: "master", patch };
};

describe("handleRegionPublish", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(composeTitle).mockClear();
    defaultPatch.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("ignores entries that aren't of type 'region'", async () => {
    const args = buildArgs([], {});
    await handleRegionPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry({ contentTypeId: "blogPost" }) as never,
    });
    expect(args.cma.entry.getMany).not.toHaveBeenCalled();
  });

  it("does nothing when no parent entries reference the region", async () => {
    const args = buildArgs([], {});
    await handleRegionPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry() as never,
    });
    expect(args.patch).not.toHaveBeenCalled();
  });

  it("patches only entries whose title field is managed by this app", async () => {
    const managed = buildParent({
      id: "p-managed",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "old",
      version: 7,
    });
    const unmanaged = buildParent({ id: "p-unmanaged", contentTypeId: "campaign" });
    const args = buildArgs([managed, unmanaged], {
      blogPost: {
        controls: [
          {
            fieldId: "internalTitle",
            widgetNamespace: "app",
            widgetId: APP_DEF_ID,
          },
        ],
      },
      campaign: { controls: [] },
    });

    await handleRegionPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry() as never,
    });

    expect(args.patch).toHaveBeenCalledTimes(1);
    expect(args.patch).toHaveBeenCalledWith(
      { entryId: "p-managed", version: 7 },
      [
        {
          op: "add",
          path: "/fields/internalTitle/en-US",
          value: "EMEA - blogPost",
        },
      ],
    );
  });

  it("ignores controls whose widgetId doesn't match this app's definition id", async () => {
    const parent = buildParent({
      id: "p1",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "old",
    });
    const args = buildArgs([parent], {
      blogPost: {
        controls: [
          {
            fieldId: "internalTitle",
            widgetNamespace: "app",
            widgetId: "some-other-app",
          },
        ],
      },
    });

    await handleRegionPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry() as never,
    });

    expect(args.patch).not.toHaveBeenCalled();
  });

  it("skips the CMA patch when the new title matches the current title", async () => {
    const parent = buildParent({
      id: "p1",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "EMEA - blogPost",
    });
    const args = buildArgs([parent], {
      blogPost: {
        controls: [
          {
            fieldId: "internalTitle",
            widgetNamespace: "app",
            widgetId: APP_DEF_ID,
          },
        ],
      },
    });

    await handleRegionPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry() as never,
    });

    expect(args.patch).not.toHaveBeenCalled();
  });

  it("paginates through links_to_entry results", async () => {
    const patch = vi.fn(async ({ entryId }: { entryId: string }) => ({
      sys: { id: entryId, version: 2 },
      fields: { internalTitle: { "en-US": "EMEA - blogPost" } },
    }));
    let call = 0;
    const cma = {
      locale: {
        getMany: vi.fn(async () => ({
          items: [{ code: "en-US", default: true }],
        })),
      },
      entry: {
        getMany: vi.fn(async () => {
          call += 1;
          if (call === 1) {
            return {
              items: Array.from({ length: 100 }, (_, i) =>
                buildParent({
                  id: `p${i}`,
                  contentTypeId: "blogPost",
                  titleFieldId: "internalTitle",
                  currentTitle: "old",
                }),
              ),
              total: 101,
            };
          }
          return {
            items: [
              buildParent({
                id: "p100",
                contentTypeId: "blogPost",
                titleFieldId: "internalTitle",
                currentTitle: "old",
              }),
            ],
            total: 101,
          };
        }),
        patch,
      },
      editorInterface: {
        get: vi.fn(async () => ({
          controls: [
            {
              fieldId: "internalTitle",
              widgetNamespace: "app",
              widgetId: APP_DEF_ID,
            },
          ],
        })),
      },
    };

    await handleRegionPublish({
      cma: cma as never,
      environmentId: "master",
      sourceEntry: buildSourceEntry() as never,
    });

    expect(cma.entry.getMany).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(101);
  });

  it("continues processing other parents when one parent's patch fails", async () => {
    const p1 = buildParent({
      id: "p1",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "old",
    });
    const p2 = buildParent({
      id: "p2",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "old",
    });
    const patch = vi
      .fn()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({
        sys: { id: "p2", version: 2 },
        fields: { internalTitle: { "en-US": "EMEA - blogPost" } },
      });
    const cma = {
      locale: {
        getMany: vi.fn(async () => ({
          items: [{ code: "en-US", default: true }],
        })),
      },
      entry: {
        getMany: vi.fn(async () => ({ items: [p1, p2], total: 2 })),
        patch,
      },
      editorInterface: {
        get: vi.fn(async () => ({
          controls: [
            {
              fieldId: "internalTitle",
              widgetNamespace: "app",
              widgetId: APP_DEF_ID,
            },
          ],
        })),
      },
    };

    await handleRegionPublish({
      cma: cma as never,
      environmentId: "master",
      sourceEntry: buildSourceEntry() as never,
    });

    expect(patch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });
});
