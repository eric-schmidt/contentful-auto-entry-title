import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/strategies", () => ({
  composition: {
    fragments: [],
    separator: " - ",
  },
}));

vi.mock("../../src/strategies/compose", () => ({
  composeTitle: vi.fn(async () => "EMEA - blogPost"),
  joinFragments: (fragments: string[], sep?: string) =>
    fragments.filter((s) => s !== "").join(sep ?? ""),
}));

import { handler } from "./index";
import { composeTitle } from "../../src/strategies/compose";

const PUBLISH_TOPIC = "ContentManagement.Entry.publish";

const buildEvent = (overrides: { topic?: string; contentTypeId?: string; entryId?: string }) => ({
  headers: { "X-Contentful-Topic": overrides.topic ?? PUBLISH_TOPIC },
  body: {
    sys: {
      id: overrides.entryId ?? "region-1",
      contentType: { sys: { id: overrides.contentTypeId ?? "region" } },
    },
    fields: {},
  },
});

const buildParent = (overrides: {
  id: string;
  contentTypeId: string;
  titleFieldId?: string;
  currentTitle?: string;
}) => ({
  sys: {
    id: overrides.id,
    contentType: { sys: { id: overrides.contentTypeId } },
  },
  fields: overrides.titleFieldId
    ? {
        [overrides.titleFieldId]: { "en-US": overrides.currentTitle ?? "" },
      }
    : {},
});

const buildContext = (
  parents: ReturnType<typeof buildParent>[],
  editorInterfaces: Record<
    string,
    { controls?: { fieldId: string; widgetNamespace: string; widgetId: string }[] }
  >,
  appInstallationId = "auto-entry-title-app",
) => {
  const update = vi.fn(async (_id, payload) => payload);
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
      update,
    },
    editorInterface: {
      get: vi.fn(async ({ contentTypeId }: { contentTypeId: string }) => {
        const ei = editorInterfaces[contentTypeId];
        if (!ei) throw new Error("not found");
        return ei;
      }),
    },
  };
  return { cma, appInstallationId, environmentId: "master", update };
};

describe("regionTitlePropagator handler", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(composeTitle).mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("ignores events that aren't entry.publish", async () => {
    const ctx = buildContext([], {});
    await handler(
      buildEvent({ topic: "ContentManagement.Entry.save" }) as never,
      ctx as never,
    );
    expect(ctx.cma.entry.getMany).not.toHaveBeenCalled();
  });

  it("ignores entries that aren't of type 'region'", async () => {
    const ctx = buildContext([], {});
    await handler(
      buildEvent({ contentTypeId: "blogPost" }) as never,
      ctx as never,
    );
    expect(ctx.cma.entry.getMany).not.toHaveBeenCalled();
  });

  it("does nothing when no parent entries reference the region", async () => {
    const ctx = buildContext([], {});
    await handler(buildEvent({}) as never, ctx as never);
    expect(ctx.update).not.toHaveBeenCalled();
  });

  it("updates only entries whose title field is managed by this app", async () => {
    const managed = buildParent({
      id: "p-managed",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "old",
    });
    const unmanaged = buildParent({ id: "p-unmanaged", contentTypeId: "campaign" });
    const ctx = buildContext([managed, unmanaged], {
      blogPost: {
        controls: [
          {
            fieldId: "internalTitle",
            widgetNamespace: "app",
            widgetId: "auto-entry-title-app",
          },
        ],
      },
      campaign: { controls: [] },
    });

    await handler(buildEvent({}) as never, ctx as never);

    expect(ctx.update).toHaveBeenCalledTimes(1);
    expect(ctx.update).toHaveBeenCalledWith(
      { entryId: "p-managed" },
      expect.objectContaining({
        fields: expect.objectContaining({
          internalTitle: { "en-US": "EMEA - blogPost" },
        }),
      }),
    );
  });

  it("skips the CMA write when the new title matches the current title", async () => {
    const parent = buildParent({
      id: "p1",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "EMEA - blogPost",
    });
    const ctx = buildContext([parent], {
      blogPost: {
        controls: [
          {
            fieldId: "internalTitle",
            widgetNamespace: "app",
            widgetId: "auto-entry-title-app",
          },
        ],
      },
    });

    await handler(buildEvent({}) as never, ctx as never);

    expect(ctx.update).not.toHaveBeenCalled();
  });

  it("paginates through links_to_entry results", async () => {
    const update = vi.fn(async (_id, payload) => payload);
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
        update,
      },
      editorInterface: {
        get: vi.fn(async () => ({
          controls: [
            {
              fieldId: "internalTitle",
              widgetNamespace: "app",
              widgetId: "auto-entry-title-app",
            },
          ],
        })),
      },
    };

    await handler(
      buildEvent({}) as never,
      { cma, appInstallationId: "auto-entry-title-app" } as never,
    );

    expect(cma.entry.getMany).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(101);
  });

  it("continues processing other parents when one parent's update fails", async () => {
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
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({});
    const cma = {
      locale: {
        getMany: vi.fn(async () => ({
          items: [{ code: "en-US", default: true }],
        })),
      },
      entry: {
        getMany: vi.fn(async () => ({ items: [p1, p2], total: 2 })),
        update,
      },
      editorInterface: {
        get: vi.fn(async () => ({
          controls: [
            {
              fieldId: "internalTitle",
              widgetNamespace: "app",
              widgetId: "auto-entry-title-app",
            },
          ],
        })),
      },
    };

    await handler(
      buildEvent({}) as never,
      { cma, appInstallationId: "auto-entry-title-app" } as never,
    );

    expect(update).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });
});
