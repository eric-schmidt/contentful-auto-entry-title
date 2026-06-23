import { describe, it, expect, vi } from "vitest";
import { publicationDate, formatPublicationDate } from "./publicationDate";
import { mockEmitter } from "./testEmitter";

describe("formatPublicationDate", () => {
  it("returns Mon-DD with leading-zero day", () => {
    expect(formatPublicationDate("2026-07-04T12:00:00Z")).toBe("Jul-04");
    expect(formatPublicationDate("2026-12-29T00:00:00Z")).toBe("Dec-29");
  });

  it("computes the date in the supplied timezone", () => {
    // 2026-07-04 03:00 UTC is 2026-07-03 20:00 in Los Angeles.
    expect(
      formatPublicationDate("2026-07-04T03:00:00Z", "America/Los_Angeles"),
    ).toBe("Jul-03");
  });

  it("falls back to UTC when no timezone is supplied", () => {
    expect(formatPublicationDate("2026-07-04T03:00:00Z")).toBe("Jul-04");
  });

  it("returns empty string for an invalid date", () => {
    expect(formatPublicationDate("not-a-date")).toBe("");
  });
});

describe("publicationDate", () => {
  describe("subscribe", () => {
    it("calls emit.skip() and returns a no-op teardown", () => {
      const emit = mockEmitter();
      const teardown = publicationDate().subscribe({
        sdk: {} as never,
        emit,
      });

      expect(emit.skip).toHaveBeenCalledOnce();
      expect(emit).not.toHaveBeenCalled();
      expect(typeof teardown).toBe("function");
      expect(() => teardown()).not.toThrow();
    });
  });

  describe("compute", () => {
    const buildCma = (
      releases: { items: { sys: { id: string } }[] },
      scheduled: {
        items: {
          scheduledFor: { datetime: string; timezone?: string };
        }[];
      },
    ) =>
      ({
        release: { query: vi.fn(async () => releases) },
        scheduledActions: { getMany: vi.fn(async () => scheduled) },
      }) as never;

    const buildEntry = () =>
      ({
        sys: { id: "p1", contentType: { sys: { id: "blogPost" } } },
        fields: {},
      }) as never;

    it("returns empty string when entry isn't in any release", async () => {
      const cma = buildCma({ items: [] }, { items: [] });
      const result = await publicationDate().compute({
        entry: buildEntry(),
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("");
    });

    it("returns empty string when releases have no scheduled action", async () => {
      const cma = buildCma(
        { items: [{ sys: { id: "rel-1" } }] },
        { items: [] },
      );
      const result = await publicationDate().compute({
        entry: buildEntry(),
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("");
    });

    it("returns the formatted date when a scheduled release exists", async () => {
      const cma = buildCma(
        { items: [{ sys: { id: "rel-1" } }] },
        {
          items: [
            { scheduledFor: { datetime: "2026-07-04T12:00:00Z" } },
          ],
        },
      );
      const result = await publicationDate().compute({
        entry: buildEntry(),
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("Jul-04");
    });

    it("respects the scheduledFor timezone", async () => {
      const cma = buildCma(
        { items: [{ sys: { id: "rel-1" } }] },
        {
          items: [
            {
              scheduledFor: {
                datetime: "2026-07-04T03:00:00Z",
                timezone: "America/Los_Angeles",
              },
            },
          ],
        },
      );
      const result = await publicationDate().compute({
        entry: buildEntry(),
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("Jul-03");
    });

    it("picks the earliest scheduled date when multiple releases are scheduled", async () => {
      const cma = buildCma(
        {
          items: [{ sys: { id: "rel-1" } }, { sys: { id: "rel-2" } }],
        },
        {
          items: [
            { scheduledFor: { datetime: "2026-08-15T12:00:00Z" } },
            { scheduledFor: { datetime: "2026-07-04T12:00:00Z" } },
          ],
        },
      );
      const result = await publicationDate().compute({
        entry: buildEntry(),
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("Jul-04");
    });
  });
});
