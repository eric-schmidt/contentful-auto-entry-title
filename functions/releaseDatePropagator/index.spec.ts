import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/strategies", () => ({
  composition: {
    fragments: [],
    separator: " - ",
  },
}));

vi.mock("../../src/strategies/compose", () => ({
  composeTitle: vi.fn(async () => "Jul-04 - composed"),
  joinFragments: (fragments: string[], sep?: string) =>
    fragments.filter((s) => s !== "").join(sep ?? ""),
}));

import { handler } from "./index";
import { composeTitle } from "../../src/strategies/compose";

const RELEASE_SAVE = "ContentManagement.Release.save";
const SCHEDULED_ACTION_CREATE = "ContentManagement.ScheduledAction.create";
const SCHEDULED_ACTION_DELETE = "ContentManagement.ScheduledAction.delete";

const buildReleaseEvent = (overrides: { topic?: string; releaseId?: string } = {}) => ({
  headers: { "X-Contentful-Topic": overrides.topic ?? RELEASE_SAVE },
  body: {
    sys: { id: overrides.releaseId ?? "rel-1", type: "Release" },
    entities: { items: [] },
  } as never,
});

const buildScheduledActionEvent = (overrides: {
  topic?: string;
  releaseId?: string;
  linkType?: string;
}) => ({
  headers: { "X-Contentful-Topic": overrides.topic ?? SCHEDULED_ACTION_CREATE },
  body: {
    sys: { id: "sa-1", type: "ScheduledAction" },
    entity: {
      sys: { id: overrides.releaseId ?? "rel-1", linkType: overrides.linkType ?? "Release" },
    },
  } as never,
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

const buildContext = (overrides: {
  release?: { entities?: { items?: { sys: { id: string; linkType: string } }[] } } | null;
  parents?: ReturnType<typeof buildParent>[];
  editorInterfaces?: Record<
    string,
    { controls?: { fieldId: string; widgetNamespace: string; widgetId: string }[] }
  >;
  appInstallationId?: string;
}) => {
  const update = vi.fn(async (_id, payload) => payload);
  const releaseGet = vi.fn(async () => {
    if (overrides.release === null) throw new Error("404");
    return overrides.release ?? { entities: { items: [] } };
  });
  const entryGet = vi.fn(async ({ entryId }: { entryId: string }) => {
    const parent = (overrides.parents ?? []).find((p) => p.sys.id === entryId);
    if (!parent) throw new Error(`no such entry ${entryId}`);
    return parent;
  });
  const editorInterfaceGet = vi.fn(
    async ({ contentTypeId }: { contentTypeId: string }) => {
      const ei = (overrides.editorInterfaces ?? {})[contentTypeId];
      if (!ei) throw new Error("not found");
      return ei;
    },
  );
  const cma = {
    locale: {
      getMany: vi.fn(async () => ({
        items: [{ code: "en-US", default: true }],
      })),
    },
    release: { get: releaseGet },
    entry: { get: entryGet, update },
    editorInterface: { get: editorInterfaceGet },
  };
  return {
    cma,
    update,
    releaseGet,
    entryGet,
    appInstallationId: overrides.appInstallationId ?? "auto-entry-title-app",
    environmentId: "master",
  };
};

describe("releaseDatePropagator handler", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(composeTitle).mockClear();
    vi.mocked(composeTitle).mockResolvedValue("Jul-04 - composed");
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("ignores ScheduledAction events whose target isn't a Release", async () => {
    const ctx = buildContext({});
    await handler(
      buildScheduledActionEvent({ linkType: "Entry" }) as never,
      ctx as never,
    );
    expect(ctx.releaseGet).not.toHaveBeenCalled();
  });

  it("ignores topics outside Release.* and ScheduledAction.*", async () => {
    const ctx = buildContext({});
    await handler(
      {
        headers: { "X-Contentful-Topic": "ContentManagement.Entry.publish" },
        body: { sys: { id: "x", type: "Entry" } } as never,
      } as never,
      ctx as never,
    );
    expect(ctx.releaseGet).not.toHaveBeenCalled();
  });

  it("exits cleanly when the Release is no longer findable", async () => {
    const ctx = buildContext({ release: null });
    await handler(buildReleaseEvent() as never, ctx as never);
    expect(ctx.update).not.toHaveBeenCalled();
  });

  it("does no work when the Release has no entry members", async () => {
    const ctx = buildContext({ release: { entities: { items: [] } } });
    await handler(buildReleaseEvent() as never, ctx as never);
    expect(ctx.update).not.toHaveBeenCalled();
  });

  it("updates only entries whose title field is managed by this app", async () => {
    const managed = buildParent({
      id: "p-managed",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "old",
    });
    const unmanaged = buildParent({
      id: "p-unmanaged",
      contentTypeId: "campaign",
    });
    const ctx = buildContext({
      release: {
        entities: {
          items: [
            { sys: { id: "p-managed", linkType: "Entry" } },
            { sys: { id: "p-unmanaged", linkType: "Entry" } },
          ],
        },
      },
      parents: [managed, unmanaged],
      editorInterfaces: {
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
      },
    });

    await handler(buildReleaseEvent() as never, ctx as never);

    expect(ctx.update).toHaveBeenCalledTimes(1);
    expect(ctx.update).toHaveBeenCalledWith(
      { entryId: "p-managed" },
      expect.objectContaining({
        fields: expect.objectContaining({
          internalTitle: { "en-US": "Jul-04 - composed" },
        }),
      }),
    );
  });

  it("recomputes via composeTitle for ScheduledAction.delete (date drops)", async () => {
    vi.mocked(composeTitle).mockResolvedValueOnce("Brand - composed"); // no date
    const parent = buildParent({
      id: "p1",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "Jul-04 - Brand - composed",
    });
    const ctx = buildContext({
      release: {
        entities: { items: [{ sys: { id: "p1", linkType: "Entry" } }] },
      },
      parents: [parent],
      editorInterfaces: {
        blogPost: {
          controls: [
            {
              fieldId: "internalTitle",
              widgetNamespace: "app",
              widgetId: "auto-entry-title-app",
            },
          ],
        },
      },
    });

    await handler(
      buildScheduledActionEvent({ topic: SCHEDULED_ACTION_DELETE }) as never,
      ctx as never,
    );

    expect(ctx.update).toHaveBeenCalledWith(
      { entryId: "p1" },
      expect.objectContaining({
        fields: expect.objectContaining({
          internalTitle: { "en-US": "Brand - composed" },
        }),
      }),
    );
  });

  it("skips the CMA write when the new title matches the current title", async () => {
    vi.mocked(composeTitle).mockResolvedValueOnce("Jul-04 - composed");
    const parent = buildParent({
      id: "p1",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "Jul-04 - composed",
    });
    const ctx = buildContext({
      release: {
        entities: { items: [{ sys: { id: "p1", linkType: "Entry" } }] },
      },
      parents: [parent],
      editorInterfaces: {
        blogPost: {
          controls: [
            {
              fieldId: "internalTitle",
              widgetNamespace: "app",
              widgetId: "auto-entry-title-app",
            },
          ],
        },
      },
    });

    await handler(buildReleaseEvent() as never, ctx as never);

    expect(ctx.update).not.toHaveBeenCalled();
  });

  it("continues processing other parents when one parent fails", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({});
    const ctx = buildContext({
      release: {
        entities: {
          items: [
            { sys: { id: "p1", linkType: "Entry" } },
            { sys: { id: "p2", linkType: "Entry" } },
          ],
        },
      },
      parents: [
        buildParent({
          id: "p1",
          contentTypeId: "blogPost",
          titleFieldId: "internalTitle",
          currentTitle: "old",
        }),
        buildParent({
          id: "p2",
          contentTypeId: "blogPost",
          titleFieldId: "internalTitle",
          currentTitle: "old",
        }),
      ],
      editorInterfaces: {
        blogPost: {
          controls: [
            {
              fieldId: "internalTitle",
              widgetNamespace: "app",
              widgetId: "auto-entry-title-app",
            },
          ],
        },
      },
    });
    ctx.cma.entry.update = update;

    await handler(buildReleaseEvent() as never, ctx as never);

    expect(update).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });
});
