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

import { handleLinkedEntryPublish } from "./linkedEntryTitle";
import { composeTitle } from "../../src/fragments/compose";

const APP_DEF_ID = "test-app-def-id";

beforeAll(() => {
  // The function code references the build-time-injected `__APP_DEFINITION_ID__`
  // global; in tests we stub it onto globalThis.
  (globalThis as { __APP_DEFINITION_ID__?: string }).__APP_DEFINITION_ID__ = APP_DEF_ID;
});

// The App Event body. Deliberately carries NO `metadata` and NO `sys.version`,
// because a real one may carry neither — that's exactly what the handler's
// re-fetch exists to correct, and the asymmetry against `buildFetchedSource`
// below is what proves the fetched copy is the one that reaches `composeTitle`.
const buildSourceEntry = (overrides: { contentTypeId?: string; entryId?: string } = {}) => ({
  sys: {
    id: overrides.entryId ?? "region-1",
    contentType: { sys: { id: overrides.contentTypeId ?? "region" } },
  },
  fields: {},
});

// What `cma.entry.get` returns for the published entry: a full EntryProps, with
// `metadata` and a current `sys.version`.
const buildFetchedSource = (overrides: {
  entryId?: string;
  contentTypeId?: string;
  titleFieldId?: string;
  currentTitle?: string;
  version?: number;
} = {}) => ({
  sys: {
    id: overrides.entryId ?? "region-1",
    version: overrides.version ?? 11,
    contentType: { sys: { id: overrides.contentTypeId ?? "region" } },
  },
  metadata: {
    tags: [],
    concepts: [
      { sys: { type: "Link", linkType: "TaxonomyConcept", id: "mens" } },
    ],
  },
  fields: overrides.titleFieldId
    ? { [overrides.titleFieldId]: { "en-US": overrides.currentTitle ?? "" } }
    : {},
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
  // What `entry.get` resolves to for the published entry. Pass `null` to make
  // the fetch reject. Defaults to an unmanaged source, so the existing
  // patch-count assertions keep counting only referencing parents.
  fetchedSource: ReturnType<typeof buildFetchedSource> | null = buildFetchedSource(),
) => {
  const patch = vi.fn(async ({ entryId }: { entryId: string }, _ops) => ({
    sys: { id: entryId, version: 2 },
    fields: { internalTitle: { "en-US": "EMEA - blogPost" } },
  }));
  const publish = vi.fn();
  const cma = {
    locale: {
      getMany: vi.fn(async () => ({
        items: [{ code: "en-US", default: true }],
      })),
    },
    entry: {
      get: vi.fn(async () => {
        if (!fetchedSource) throw new Error("entry.get failed");
        return fetchedSource;
      }),
      getMany: vi.fn(async ({ query }: { query: { skip: number } }) => ({
        items: query.skip === 0 ? parents : [],
        total: parents.length,
      })),
      patch,
      // Never called. This handler writes drafts only — see the spec at the
      // bottom of this file that pins it.
      publish,
    },
    editorInterface: {
      get: vi.fn(async ({ contentTypeId }: { contentTypeId: string }) => {
        const ei = editorInterfaces[contentTypeId];
        if (!ei) throw new Error("not found");
        return ei;
      }),
    },
  };
  return { cma, environmentId: "master", patch, publish };
};

describe("handleLinkedEntryPublish", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(composeTitle).mockClear();
    defaultPatch.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("does nothing when no parent entries reference the published entry", async () => {
    // No editor interfaces at all, so the source's own content type is
    // unmanaged too — otherwise this would now patch the source and stop
    // asserting what its name says.
    const args = buildArgs([], {});
    await handleLinkedEntryPublish({
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

    await handleLinkedEntryPublish({
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

    await handleLinkedEntryPublish({
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

    await handleLinkedEntryPublish({
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
        // Unmanaged source, so the patch count below still counts only parents.
        get: vi.fn(async () => buildFetchedSource()),
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
        // Scoped to blogPost on purpose: the source (`region`) must stay
        // unmanaged so the patch count below counts only the parents.
        get: vi.fn(async ({ contentTypeId }: { contentTypeId: string }) => {
          if (contentTypeId !== "blogPost") throw new Error("not found");
          return {
            controls: [
              {
                fieldId: "internalTitle",
                widgetNamespace: "app",
                widgetId: APP_DEF_ID,
              },
            ],
          };
        }),
      },
    };

    await handleLinkedEntryPublish({
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
        // Unmanaged source, so only p1 and p2 are patched.
        get: vi.fn(async () => buildFetchedSource()),
        getMany: vi.fn(async () => ({ items: [p1, p2], total: 2 })),
        patch,
      },
      editorInterface: {
        // Scoped to blogPost on purpose: the source (`region`) must stay
        // unmanaged so the patch count below counts only the parents.
        get: vi.fn(async ({ contentTypeId }: { contentTypeId: string }) => {
          if (contentTypeId !== "blogPost") throw new Error("not found");
          return {
            controls: [
              {
                fieldId: "internalTitle",
                widgetNamespace: "app",
                widgetId: APP_DEF_ID,
              },
            ],
          };
        }),
      },
    };

    await handleLinkedEntryPublish({
      cma: cma as never,
      environmentId: "master",
      sourceEntry: buildSourceEntry() as never,
    });

    expect(patch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });
  it("reads each content type's editor interface only once per invocation", async () => {
    // Regression: `findManagedTitleFieldId` used to call `editorInterface.get`
    // once per parent entry. With many parents sharing one content type — the
    // normal case — that burned N requests against a 7 req/s CMA limit for a
    // value that cannot change mid-invocation, and was a direct cause of
    // observed 429 storms. The lookup must be memoized per content type.
    const parents = Array.from({ length: 12 }, (_, i) =>
      buildParent({
        id: `p${i}`,
        contentTypeId: "pdpPage",
        titleFieldId: "adminTitle",
        currentTitle: "old",
        version: 1,
      }),
    );
    const args = buildArgs(parents, {
      pdpPage: {
        controls: [
          {
            fieldId: "adminTitle",
            widgetNamespace: "app",
            widgetId: APP_DEF_ID,
          },
        ],
      },
    });

    await handleLinkedEntryPublish({
      cma: args.cma as never,
      environmentId: "master",
      sourceEntry: buildSourceEntry() as never,
    });

    expect(args.patch).toHaveBeenCalledTimes(12);
    // Twelve parents sharing `pdpPage` must cost exactly one lookup. The source
    // entry's own content type (`region`) accounts for the other call — one per
    // distinct content type is the contract, not one per invocation.
    const lookedUp = args.cma.editorInterface.get.mock.calls.map(
      ([{ contentTypeId }]: [{ contentTypeId: string }]) => contentTypeId,
    );
    expect(lookedUp.filter((id: string) => id === "pdpPage")).toHaveLength(1);
    expect(new Set(lookedUp)).toEqual(new Set(["region", "pdpPage"]));
  });

  // ---------------------------------------------------------------------------
  // The published entry itself.
  //
  // Concepts are assigned on the Taxonomy tab, where our field widget is
  // unmounted, so publishing from there used to persist a stale title that
  // nothing corrected: this handler recomputed entries that LINK TO the
  // published entry but never the published entry itself.
  // ---------------------------------------------------------------------------

  const MANAGED_PDP = {
    pdpPage: {
      controls: [
        {
          fieldId: "adminTitle",
          widgetNamespace: "app",
          widgetId: APP_DEF_ID,
        },
      ],
    },
  };

  it("passes the FETCHED entry to composeTitle, not the event body", async () => {
    // The regression guard for the worst failure mode available here. The event
    // body has no `metadata`, and `conceptNotation.compute` resolves zero
    // concept ids to "" rather than `null` — so composing from the body would
    // produce a title MISSING the notation blob, sail past the `null` guard in
    // `recomputeTitleForEntries`, and PATCH the truncated title over the real
    // one. Nothing in the type system catches that: `FragmentComputeEntry` has
    // `metadata` optional and no `sys.version` at all.
    const args = buildArgs(
      [],
      MANAGED_PDP,
      buildFetchedSource({
        entryId: "pdp-1",
        contentTypeId: "pdpPage",
        titleFieldId: "adminTitle",
        currentTitle: "stale",
      }),
    );

    await handleLinkedEntryPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry({
        entryId: "pdp-1",
        contentTypeId: "pdpPage",
      }) as never,
    });

    const passedEntry = vi.mocked(composeTitle).mock.calls[0][1].entry;
    expect(passedEntry.metadata).toBeDefined();
    expect(passedEntry.metadata?.concepts?.[0].sys.id).toBe("mens");
    // The other half of the re-fetch's job: `FragmentComputeEntry.sys` carries
    // no `version` at all, so the only place the fresh version is observable is
    // the PATCH. 11 is the fetched copy's; the event body has none.
    expect(args.patch).toHaveBeenCalledWith(
      { entryId: "pdp-1", version: 11 },
      expect.anything(),
    );
  });

  it("patches the published entry itself when nothing references it", async () => {
    // Literally the reported bug, and the common case in the shipped content
    // model: nothing links to `pdpPage`, so before this change a `pdpPage`
    // publish did no work at all.
    const args = buildArgs(
      [],
      MANAGED_PDP,
      buildFetchedSource({
        entryId: "pdp-1",
        contentTypeId: "pdpPage",
        titleFieldId: "adminTitle",
        currentTitle: "stale",
        version: 11,
      }),
    );

    await handleLinkedEntryPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry({
        entryId: "pdp-1",
        contentTypeId: "pdpPage",
      }) as never,
    });

    expect(args.patch).toHaveBeenCalledTimes(1);
    expect(args.patch).toHaveBeenCalledWith(
      { entryId: "pdp-1", version: 11 },
      [
        {
          op: "add",
          path: "/fields/adminTitle/en-US",
          value: "EMEA - blogPost",
        },
      ],
    );
  });

  it("never publishes anything — draft writes only", async () => {
    // The invariant the whole recursion-safety argument rests on: this handler
    // PATCHes drafts, which emit `Entry.save`, and the dispatcher routes only
    // `Entry.publish` / `Release.*` / `ScheduledAction.*`. Publishing here
    // would feed our own write straight back into this handler.
    const args = buildArgs(
      [
        buildParent({
          id: "p1",
          contentTypeId: "pdpPage",
          titleFieldId: "adminTitle",
          currentTitle: "old",
        }),
      ],
      MANAGED_PDP,
      buildFetchedSource({
        contentTypeId: "pdpPage",
        titleFieldId: "adminTitle",
        currentTitle: "stale",
      }),
    );

    await handleLinkedEntryPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry({ contentTypeId: "pdpPage" }) as never,
    });

    expect(args.patch).toHaveBeenCalledTimes(2);
    expect(args.publish).not.toHaveBeenCalled();
  });

  it("skips the published entry when composeTitle returns null", async () => {
    // `null` = a fragment couldn't determine its contribution, in practice a
    // taxonomy read that didn't happen. Writing the shortened title would
    // delete the real one.
    vi.mocked(composeTitle).mockResolvedValueOnce(null as never);
    const args = buildArgs(
      [],
      MANAGED_PDP,
      buildFetchedSource({
        contentTypeId: "pdpPage",
        titleFieldId: "adminTitle",
        currentTitle: "stale",
      }),
    );

    await handleLinkedEntryPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry({ contentTypeId: "pdpPage" }) as never,
    });

    expect(args.patch).not.toHaveBeenCalled();
  });

  it("skips the published entry when its title is already correct", async () => {
    // What makes the follow-up publish (the one that clears the "Changed"
    // badge) free rather than a second write.
    const args = buildArgs(
      [],
      MANAGED_PDP,
      buildFetchedSource({
        contentTypeId: "pdpPage",
        titleFieldId: "adminTitle",
        currentTitle: "EMEA - blogPost",
      }),
    );

    await handleLinkedEntryPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry({ contentTypeId: "pdpPage" }) as never,
    });

    expect(args.patch).not.toHaveBeenCalled();
  });

  it("recomputes the published entry before its referencing parents", async () => {
    // Not cosmetic: `referencedEntryTitle.compute` reads its linked entry's
    // DRAFT title over the CMA, so the source has to be patched before the
    // parents are composed or they read the stale value and stay stale until
    // some later event.
    const args = buildArgs(
      [
        buildParent({
          id: "p1",
          contentTypeId: "pdpPage",
          titleFieldId: "adminTitle",
          currentTitle: "old",
        }),
      ],
      MANAGED_PDP,
      buildFetchedSource({
        entryId: "src-1",
        contentTypeId: "pdpPage",
        titleFieldId: "adminTitle",
        currentTitle: "stale",
      }),
    );

    await handleLinkedEntryPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry({
        entryId: "src-1",
        contentTypeId: "pdpPage",
      }) as never,
    });

    expect(vi.mocked(composeTitle).mock.calls[0][1].entry.sys.id).toBe("src-1");
    expect(vi.mocked(composeTitle).mock.calls[1][1].entry.sys.id).toBe("p1");
  });

  it("processes the published entry once when links_to_entry returns it", async () => {
    // A self-referencing content type puts the source in its own parent list.
    // Without the dedupe the second pass would carry the pre-fetch snapshot's
    // version and 409 — which is warned and swallowed, so it would look fine.
    const selfLink = buildParent({
      id: "src-1",
      contentTypeId: "pdpPage",
      titleFieldId: "adminTitle",
      currentTitle: "stale",
      version: 1,
    });
    const args = buildArgs([selfLink], MANAGED_PDP, {
      ...buildFetchedSource({
        entryId: "src-1",
        contentTypeId: "pdpPage",
        titleFieldId: "adminTitle",
        currentTitle: "stale",
        version: 11,
      }),
    });

    await handleLinkedEntryPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry({
        entryId: "src-1",
        contentTypeId: "pdpPage",
      }) as never,
    });

    expect(args.patch).toHaveBeenCalledTimes(1);
    // The re-fetched copy wins, so the version is 11 and not the stale 1.
    expect(args.patch).toHaveBeenCalledWith(
      { entryId: "src-1", version: 11 },
      expect.anything(),
    );
  });

  it("still recomputes parents when fetching the published entry fails", async () => {
    // The fetch sits in its own try/catch so a failure costs only the source's
    // own title, never the fan-out.
    const args = buildArgs(
      [
        buildParent({
          id: "p1",
          contentTypeId: "pdpPage",
          titleFieldId: "adminTitle",
          currentTitle: "old",
        }),
      ],
      MANAGED_PDP,
      null,
    );

    await handleLinkedEntryPublish({
      cma: args.cma as never,
      environmentId: args.environmentId,
      sourceEntry: buildSourceEntry({ contentTypeId: "pdpPage" }) as never,
    });

    expect(args.patch).toHaveBeenCalledTimes(1);
    expect(args.patch).toHaveBeenCalledWith(
      { entryId: "p1", version: 1 },
      expect.anything(),
    );
    expect(warnSpy).toHaveBeenCalled();
  });
});
