import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const buildArgs = (overrides: {
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

describe("handleReleaseOrScheduledActionEvent", () => {
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
    const args = buildArgs({});
    await handleReleaseOrScheduledActionEvent({
      cma: args.cma as never,
      appInstallationId: args.appInstallationId,
      environmentId: args.environmentId,
      topic: SCHEDULED_ACTION_CREATE,
      body: buildScheduledActionBody({ linkType: "Entry" }) as never,
    });
    expect(args.releaseGet).not.toHaveBeenCalled();
  });

  it("exits cleanly when the Release is no longer findable", async () => {
    const args = buildArgs({ release: null });
    await handleReleaseOrScheduledActionEvent({
      cma: args.cma as never,
      appInstallationId: args.appInstallationId,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });
    expect(args.update).not.toHaveBeenCalled();
  });

  it("does no work when the Release has no entry members", async () => {
    const args = buildArgs({ release: { entities: { items: [] } } });
    await handleReleaseOrScheduledActionEvent({
      cma: args.cma as never,
      appInstallationId: args.appInstallationId,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });
    expect(args.update).not.toHaveBeenCalled();
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
              widgetId: "auto-entry-title-app",
            },
          ],
        },
        campaign: { controls: [] },
      },
    });

    await handleReleaseOrScheduledActionEvent({
      cma: args.cma as never,
      appInstallationId: args.appInstallationId,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });

    expect(args.update).toHaveBeenCalledTimes(1);
    expect(args.update).toHaveBeenCalledWith(
      { entryId: "p-managed" },
      expect.objectContaining({
        fields: expect.objectContaining({
          internalTitle: { "en-US": "Jul-04 - composed" },
        }),
      }),
    );
  });

  it("recomputes for ScheduledAction.delete so the date drops", async () => {
    vi.mocked(composeTitle).mockResolvedValueOnce("Brand - composed"); // no date
    const parent = buildParent({
      id: "p1",
      contentTypeId: "blogPost",
      titleFieldId: "internalTitle",
      currentTitle: "Jul-04 - Brand - composed",
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
              widgetId: "auto-entry-title-app",
            },
          ],
        },
      },
    });

    await handleReleaseOrScheduledActionEvent({
      cma: args.cma as never,
      appInstallationId: args.appInstallationId,
      environmentId: args.environmentId,
      topic: SCHEDULED_ACTION_DELETE,
      body: buildScheduledActionBody({}) as never,
    });

    expect(args.update).toHaveBeenCalledWith(
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
              widgetId: "auto-entry-title-app",
            },
          ],
        },
      },
    });

    await handleReleaseOrScheduledActionEvent({
      cma: args.cma as never,
      appInstallationId: args.appInstallationId,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });

    expect(args.update).not.toHaveBeenCalled();
  });

  it("continues processing other parents when one parent fails", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({});
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
              widgetId: "auto-entry-title-app",
            },
          ],
        },
      },
    });
    args.cma.entry.update = update;

    await handleReleaseOrScheduledActionEvent({
      cma: args.cma as never,
      appInstallationId: args.appInstallationId,
      environmentId: args.environmentId,
      topic: RELEASE_SAVE,
      body: buildReleaseBody() as never,
    });

    expect(update).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });
});
