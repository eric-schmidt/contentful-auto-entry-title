import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./linkedEntryTitle", () => ({
  handleLinkedEntryPublish: vi.fn(async () => {}),
}));
vi.mock("./releaseDate", () => ({
  handleReleaseOrScheduledActionEvent: vi.fn(async () => {}),
}));

import { handler } from "./index";
import { handleLinkedEntryPublish } from "./linkedEntryTitle";
import { handleReleaseOrScheduledActionEvent } from "./releaseDate";

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

describe("dispatcher", () => {
  beforeEach(() => {
    vi.mocked(handleLinkedEntryPublish).mockClear();
    vi.mocked(handleReleaseOrScheduledActionEvent).mockClear();
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

  it("ignores topics outside the recognized set", async () => {
    const event = buildEvent("ContentManagement.Entry.save", {
      sys: { id: "e1" },
    });
    await handler(event, buildContext());

    expect(handleLinkedEntryPublish).not.toHaveBeenCalled();
    expect(handleReleaseOrScheduledActionEvent).not.toHaveBeenCalled();
  });
});
