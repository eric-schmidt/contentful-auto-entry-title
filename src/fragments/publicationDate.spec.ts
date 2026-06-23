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
    const buildSdk = (
      releases: { items: { sys: { id: string } }[] },
      scheduled: {
        items: {
          scheduledFor: { datetime: string; timezone?: string };
        }[];
      },
      ids: { entry?: string; environment?: string; environmentAlias?: string } = {},
    ) =>
      ({
        ids: {
          entry: ids.entry ?? "p1",
          environment: ids.environment ?? "master",
          environmentAlias: ids.environmentAlias,
        },
        cma: {
          release: { query: vi.fn(async () => releases) },
          scheduledActions: { getMany: vi.fn(async () => scheduled) },
        },
      }) as never;

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("emits empty string when the entry isn't in any release", async () => {
      const emit = mockEmitter();
      const teardown = publicationDate().subscribe({
        sdk: buildSdk({ items: [] }, { items: [] }),
        emit,
      });

      await flush();

      expect(emit).toHaveBeenCalledExactlyOnceWith("");
      expect(typeof teardown).toBe("function");
      expect(() => teardown()).not.toThrow();
    });

    it("emits the formatted date when a scheduled release exists", async () => {
      const emit = mockEmitter();
      publicationDate().subscribe({
        sdk: buildSdk(
          { items: [{ sys: { id: "rel-1" } }] },
          {
            items: [{ scheduledFor: { datetime: "2026-07-04T12:00:00Z" } }],
          },
        ),
        emit,
      });

      await flush();

      expect(emit).toHaveBeenCalledExactlyOnceWith("Jul-04");
    });

    it("uses environmentAlias when present, environment otherwise", async () => {
      const getMany = vi.fn(async () => ({ items: [] }));
      const sdk = {
        ids: {
          entry: "p1",
          environment: "env-uuid",
          environmentAlias: "master",
        },
        cma: {
          release: {
            query: vi.fn(async () => ({ items: [{ sys: { id: "rel-1" } }] })),
          },
          scheduledActions: { getMany },
        },
      } as never;

      publicationDate().subscribe({ sdk, emit: mockEmitter() });

      await flush();

      expect(getMany).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({ "environment.sys.id": "master" }),
        }),
      );
    });

    it("does not emit after teardown is called", async () => {
      const emit = mockEmitter();
      const teardown = publicationDate().subscribe({
        sdk: buildSdk({ items: [] }, { items: [] }),
        emit,
      });
      teardown();

      await flush();

      expect(emit).not.toHaveBeenCalled();
    });

    it("emits empty string when the CMA lookup throws", async () => {
      const emit = mockEmitter();
      const sdk = {
        ids: { entry: "p1", environment: "master" },
        cma: {
          release: {
            query: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
          scheduledActions: { getMany: vi.fn() },
        },
      } as never;
      publicationDate().subscribe({ sdk, emit });

      await flush();

      expect(emit).toHaveBeenCalledExactlyOnceWith("");
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
