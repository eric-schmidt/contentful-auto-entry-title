import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./regionTitle", () => ({
  handleRegionPublish: vi.fn(async () => {}),
}));
vi.mock("./releaseDate", () => ({
  handleReleaseOrScheduledActionEvent: vi.fn(async () => {}),
}));

import { handler } from "./index";
import { handleRegionPublish } from "./regionTitle";
import { handleReleaseOrScheduledActionEvent } from "./releaseDate";

const buildEvent = (topic: string, body: unknown = {}) => ({
  headers: { "X-Contentful-Topic": topic },
  body: body as never,
});

const buildContext = () => ({
  cma: {} as never,
  appInstallationId: "auto-entry-title-app",
  environmentId: "master",
});

describe("dispatcher", () => {
  beforeEach(() => {
    vi.mocked(handleRegionPublish).mockClear();
    vi.mocked(handleReleaseOrScheduledActionEvent).mockClear();
  });

  it("routes Entry.publish events to handleRegionPublish", async () => {
    const event = buildEvent("ContentManagement.Entry.publish", {
      sys: { id: "e1", contentType: { sys: { id: "region" } } },
      fields: {},
    });
    await handler(event, buildContext());

    expect(handleRegionPublish).toHaveBeenCalledTimes(1);
    expect(handleReleaseOrScheduledActionEvent).not.toHaveBeenCalled();
  });

  it("routes Release.save events to handleReleaseOrScheduledActionEvent", async () => {
    const event = buildEvent("ContentManagement.Release.save", {
      sys: { id: "rel-1", type: "Release" },
    });
    await handler(event, buildContext());

    expect(handleReleaseOrScheduledActionEvent).toHaveBeenCalledTimes(1);
    expect(handleRegionPublish).not.toHaveBeenCalled();
  });

  it("routes ScheduledAction.create events to handleReleaseOrScheduledActionEvent", async () => {
    const event = buildEvent("ContentManagement.ScheduledAction.create", {
      sys: { id: "sa-1", type: "ScheduledAction" },
      entity: { sys: { id: "rel-1", linkType: "Release" } },
    });
    await handler(event, buildContext());

    expect(handleReleaseOrScheduledActionEvent).toHaveBeenCalledTimes(1);
    expect(handleRegionPublish).not.toHaveBeenCalled();
  });

  it("ignores topics outside the recognized set", async () => {
    const event = buildEvent("ContentManagement.Entry.save", {
      sys: { id: "e1" },
    });
    await handler(event, buildContext());

    expect(handleRegionPublish).not.toHaveBeenCalled();
    expect(handleReleaseOrScheduledActionEvent).not.toHaveBeenCalled();
  });

  it("ignores events with no X-Contentful-Topic header", async () => {
    await handler(
      { headers: {}, body: {} as never },
      buildContext(),
    );

    expect(handleRegionPublish).not.toHaveBeenCalled();
    expect(handleReleaseOrScheduledActionEvent).not.toHaveBeenCalled();
  });
});
