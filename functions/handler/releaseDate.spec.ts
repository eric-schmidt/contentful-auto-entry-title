import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

vi.mock("../../src/fragments", () => ({
  composition: {
    fragments: [],
    separator: " - ",
  },
}));

vi.mock("../../src/fragments/compose", () => ({
  composeTitle: vi.fn(async () => "Jul-04 - composed"),
  joinFragments: (fragments: string[], sep?: string) =>
    fragments.filter((s) => s !== "").join(sep ?? ""),
}));

import { handleReleaseOrScheduledActionEvent } from "./releaseDate";
import { composeTitle } from "../../src/fragments/compose";

const RELEASE_SAVE = "ContentManagement.Release.save";
const SCHEDULED_ACTION_CREATE = "ContentManagement.ScheduledAction.create";
const SCHEDULED_ACTION_DELETE = "ContentManagement.ScheduledAction.delete";
const APP_DEF_ID = "test-app-def-id";

beforeAll(() => {
  (globalThis as { __APP_DEFINITION_ID__?: string }).__APP_DEFINITION_ID__ = APP_DEF_ID;
});

const buildReleaseBody = (releaseId = "rel-1") => ({
  sys: { id: releaseId, type: "Release" as const },
  entities: { items: [] as { sys: { id: string; linkType: string } }[] },
});

const buildScheduledActionBody = (overrides: { releaseId?: string; linkType?: string }) => ({
  sys: { id: "sa-1", type: "ScheduledAction" as const },
  entity: {
    sys: { id: overrides.releaseId ?? "rel-1", linkType: overrides.linkType ?? "Release" },
  },
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

const buildArgs = (overrides: {
  release?: { entities?: { items?: { sys: { id: string; linkType: string } }[] } } | null;
  parents?: ReturnType<typeof buildParent>[];
  editorInterfaces?: Record<
    string,
    { controls?: { fieldId: string; widgetNamespace: string; widgetId: string }[] }
  >;
}) => {
  const patch = vi.fn(async ({ entryId }: { entryId: string }) => ({
    sys: { id: entryId, version: 2 },
    fields: { internalTitle: { "en-US": "Jul-04 - composed" } },
  }));
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
    entry: { get: entryGet, patch },
    editorInterface: { get: editorInterfaceGet },
  };
  return {
    cma,
    patch,
    releaseGet,
    entryGet,
    environmentId: "master",
  };
};

describe("handleReleaseOrScheduledActionEvent", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(composeTitle).mockClear();
    vi.mocked(composeTitle).mockResolvedValue("Jul-04 - composed");
    // The release-fetch retry loop uses real setTimeout for backoff. Fake
    // timers let us fast-forward through retries without real waits.
    vi.useFakeTimers();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  // Helper: kick off the handler, advance through any retry timers, then await.
  const runHandler = async (
    args: Parameters<typeof handleReleaseOrScheduledActionEvent>[0],
  ) => {
    const promise = handleReleaseOrScheduledActionEvent(args);
    await vi.runAllTimersAsync();
    await promise;
  };

  it("ignores ScheduledAction events whose target isn't a Release", async () => {
    const args = buildArgs({});
    await runHandler({
      cma: args.cma as never,
      environmentId: args.environmentId,
      topic: SCHEDULED_ACTION_CREATE,
      body: buildScheduledActionBody({ linkType: "Entry" }) as never,
    });
    expect(args.releaseGet).not.toHaveBeenCalled();
  });

  it("exits cleanly when the Release is no longer findable", async () => {
    const args = buildArgs({ release: null });
    await runHandler({
      cma: args.cma as never,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });
    expect(args.patch).not.toHaveBeenCalled();
  });

  it("does no work when the Release has no entry members", async () => {
    const args = buildArgs({ release: { entities: { items: [] } } });
    await runHandler({
      cma: args.cma as never,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });
    expect(args.patch).not.toHaveBeenCalled();
  });

  it("patches only entries whose title field is managed by this app", async () => {
    const managed = buildParent({
      id: "p-managed",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "old",
      version: 5,
    });
    const unmanaged = buildParent({
      id: "p-unmanaged",
      contentTypeId: "campaign",
    });
    const args = buildArgs({
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
              widgetId: APP_DEF_ID,
            },
          ],
        },
        campaign: { controls: [] },
      },
    });

    await runHandler({
      cma: args.cma as never,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });

    expect(args.patch).toHaveBeenCalledTimes(1);
    expect(args.patch).toHaveBeenCalledWith(
      { entryId: "p-managed", version: 5 },
      [
        {
          op: "add",
          path: "/fields/internalTitle/en-US",
          value: "Jul-04 - composed",
        },
      ],
    );
  });

  it("recomputes for ScheduledAction.delete so the date drops", async () => {
    vi.mocked(composeTitle).mockResolvedValueOnce("Brand - composed"); // no date
    const parent = buildParent({
      id: "p1",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "Jul-04 - Brand - composed",
      version: 3,
    });
    const args = buildArgs({
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
              widgetId: APP_DEF_ID,
            },
          ],
        },
      },
    });

    await runHandler({
      cma: args.cma as never,
      environmentId: args.environmentId,
      topic: SCHEDULED_ACTION_DELETE,
      body: buildScheduledActionBody({}) as never,
    });

    expect(args.patch).toHaveBeenCalledWith(
      { entryId: "p1", version: 3 },
      [
        {
          op: "add",
          path: "/fields/internalTitle/en-US",
          value: "Brand - composed",
        },
      ],
    );
  });

  it("skips the CMA patch when the new title matches the current title", async () => {
    vi.mocked(composeTitle).mockResolvedValueOnce("Jul-04 - composed");
    const parent = buildParent({
      id: "p1",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "Jul-04 - composed",
    });
    const args = buildArgs({
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
              widgetId: APP_DEF_ID,
            },
          ],
        },
      },
    });

    await runHandler({
      cma: args.cma as never,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });

    expect(args.patch).not.toHaveBeenCalled();
  });

  it("continues processing other parents when one parent fails", async () => {
    const patch = vi
      .fn()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({
        sys: { id: "p2", version: 2 },
        fields: { internalTitle: { "en-US": "Jul-04 - composed" } },
      });
    const args = buildArgs({
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
              widgetId: APP_DEF_ID,
            },
          ],
        },
      },
    });
    args.cma.entry.patch = patch;

    await runHandler({
      cma: args.cma as never,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });

    expect(patch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });
});
