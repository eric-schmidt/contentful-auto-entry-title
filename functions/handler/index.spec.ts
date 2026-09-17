import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./linkedEntryTitle", () => ({
  handleLinkedEntryPublish: vi.fn(async () => {}),
}));
vi.mock("./releaseDate", () => ({
  handleReleaseOrScheduledActionEvent: vi.fn(async () => {}),
}));

import { handler } from "./index";
import { handleLinkedEntryPublish } from "./linkedEntryTitle";
import { handleReleaseOrScheduledActionEvent } from "./releaseDate";
import type { ConceptReader } from "../../src/fragments/types";

const stubCma = { __stub: true };

const buildEvent = (topic: string, body: unknown = {}) => ({
  headers: { "X-Contentful-Topic": topic },
  body: body as never,
});

const buildContext = () => ({
  cma: stubCma as never,
  spaceId: "space-id",
  environmentId: "master",
});

// The delivery key reaches the function as a build-time inlined global, not
// through the event context — see functions/shared/conceptReaderForFunction.ts.
// esbuild's `define` doesn't run under vitest, so tests stub the global.
const withDeliveryKey = (key: string | null) => {
  if (key === null) {
    vi.stubGlobal("__DELIVERY_KEY__", "");
    return;
  }
  vi.stubGlobal("__DELIVERY_KEY__", key);
};

// Pulls the reader the dispatcher actually forwarded off a mocked branch, so a
// test can exercise it rather than merely assert `expect.any(Function)`.
const forwardedReader = (
  branch:
    | typeof handleLinkedEntryPublish
    | typeof handleReleaseOrScheduledActionEvent,
) => {
  const args = vi.mocked(branch).mock.calls.at(-1)?.[0];
  return (args as { conceptReader?: ConceptReader } | undefined)?.conceptReader;
};

describe("dispatcher", () => {
  beforeEach(() => {
    vi.mocked(handleLinkedEntryPublish).mockClear();
    vi.mocked(handleReleaseOrScheduledActionEvent).mockClear();
  });

  // `withDeliveryKey` stubs a global and nothing restored it, so tests that
  // must run without a key only passed while they happened to be declared
  // before the first stubbing test.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes Entry.publish events to handleLinkedEntryPublish, passing context.cma through", async () => {
    const event = buildEvent("ContentManagement.Entry.publish", {
      sys: { id: "e1", contentType: { sys: { id: "region" } } },
      fields: {},
    });
    await handler(event, buildContext());

    expect(handleLinkedEntryPublish).toHaveBeenCalledTimes(1);
    expect(handleLinkedEntryPublish).toHaveBeenCalledWith(
      expect.objectContaining({ cma: stubCma, environmentId: "master" }),
    );
    expect(handleReleaseOrScheduledActionEvent).not.toHaveBeenCalled();
  });

  it("routes Release.save events to handleReleaseOrScheduledActionEvent, passing context.cma through", async () => {
    const event = buildEvent("ContentManagement.Release.save", {
      sys: { id: "rel-1", type: "Release" },
    });
    await handler(event, buildContext());

    expect(handleReleaseOrScheduledActionEvent).toHaveBeenCalledTimes(1);
    expect(handleReleaseOrScheduledActionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ cma: stubCma, environmentId: "master" }),
    );
    expect(handleLinkedEntryPublish).not.toHaveBeenCalled();
  });

  it("routes ScheduledAction.create events to handleReleaseOrScheduledActionEvent", async () => {
    const event = buildEvent("ContentManagement.ScheduledAction.create", {
      sys: { id: "sa-1", type: "ScheduledAction" },
      entity: { sys: { id: "rel-1", linkType: "Release" } },
    });
    await handler(event, buildContext());

    expect(handleReleaseOrScheduledActionEvent).toHaveBeenCalledTimes(1);
    expect(handleLinkedEntryPublish).not.toHaveBeenCalled();
  });

  // Regression guard. Every recompute runs the whole composition, which
  // includes `conceptNotation` — a branch that forgot to forward a reader would
  // silently strip the notation blob out of each title it rewrote, and nothing
  // else in the suite would notice.
  //
  // So the reader is invoked, not just type-checked: it must be wired to the
  // right space, environment and key. One built against the wrong environment
  // 404s on every read (the key is authorized per environment), which degrades
  // identically to a missing reader from a completely different cause.
  it("forwards a concept reader built from the inlined delivery key on both branches", async () => {
    withDeliveryKey("delivery-key");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    for (const [event, branch] of [
      [
        buildEvent("ContentManagement.Entry.publish", {
          sys: { id: "e1", contentType: { sys: { id: "pdpPage" } } },
          fields: {},
        }),
        handleLinkedEntryPublish,
      ],
      [
        buildEvent("ContentManagement.Release.save", {
          sys: { id: "rel-1", type: "Release" },
        }),
        handleReleaseOrScheduledActionEvent,
      ],
    ] as const) {
      fetchMock.mockClear();
      await handler(event, buildContext());

      const reader = forwardedReader(branch);
      expect(reader).toBeTypeOf("function");

      await reader!("division");

      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        { headers: Record<string, string> },
      ];
      expect(url).toContain(
        "/spaces/space-id/environments/master/taxonomy/concepts",
      );
      expect(url).toContain("conceptScheme=division");
      expect(init.headers.Authorization).toBe("Bearer delivery-key");
    }
  });

  it("warns and forwards no reader when no delivery key was inlined", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    withDeliveryKey(null);

    await handler(
      buildEvent("ContentManagement.Entry.publish", {
        sys: { id: "e1", contentType: { sys: { id: "pdpPage" } } },
        fields: {},
      }),
      buildContext(),
    );

    expect(handleLinkedEntryPublish).toHaveBeenCalledWith(
      expect.objectContaining({ conceptReader: undefined }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no delivery key was inlined"),
    );
    warnSpy.mockRestore();
  });

  it("builds no concept reader for an unrecognized topic", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Missing key AND an ignored topic: the reader is built lazily, so this must
    // stay silent rather than warn about something it was never going to use.
    withDeliveryKey(null);

    await handler(
      buildEvent("ContentManagement.Entry.save", { sys: { id: "e1" } }),
      buildContext(),
    );

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("ignores topics outside the recognized set", async () => {
    const event = buildEvent("ContentManagement.Entry.save", {
      sys: { id: "e1" },
    });
    await handler(event, buildContext());

    expect(handleLinkedEntryPublish).not.toHaveBeenCalled();
    expect(handleReleaseOrScheduledActionEvent).not.toHaveBeenCalled();
  });
});
