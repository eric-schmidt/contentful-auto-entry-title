import { describe, it, expect, vi } from "vitest";
import { contentType } from "./contentType";
import { mockEmitter } from "./testEmitter";

const buildSdk = (overrides: { name?: string; id?: string }) =>
  ({
    contentType: {
      name: overrides.name,
      sys: { id: overrides.id ?? "blogPost" },
    },
  }) as unknown as Parameters<ReturnType<typeof contentType>["subscribe"]>[0]["sdk"];

describe("contentType", () => {
  describe("subscribe", () => {
    it("emits the content type display name on mount", () => {
      const emit = mockEmitter();
      const teardown = contentType().subscribe({
        sdk: buildSdk({ name: "Blog Post", id: "blogPost" }),
        emit,
      });

      expect(emit).toHaveBeenCalledExactlyOnceWith("Blog Post");
      expect(typeof teardown).toBe("function");
      expect(() => teardown()).not.toThrow();
    });

    it("falls back to sys.id when the display name is missing", () => {
      const emit = mockEmitter();
      contentType().subscribe({
        sdk: buildSdk({ name: undefined, id: "blogPost" }),
        emit,
      });

      expect(emit).toHaveBeenCalledExactlyOnceWith("blogPost");
    });
  });

  describe("compute", () => {
    const buildEntry = (id: string) =>
      ({
        sys: { id: "e1", contentType: { sys: { id } } },
        fields: {},
      }) as never;

    it("fetches the content type and returns its name", async () => {
      const cma = {
        contentType: {
          get: vi.fn(async () => ({ name: "Blog Post" })),
        },
      } as never;

      const result = await contentType().compute({
        entry: buildEntry("blogPost"),
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("Blog Post");
    });

    it("falls back to the content type id when the fetch fails", async () => {
      const cma = {
        contentType: {
          get: vi.fn(async () => {
            throw new Error("boom");
          }),
        },
      } as never;

      const result = await contentType().compute({
        entry: buildEntry("blogPost"),
        cma,
        defaultLocale: "en-US",
        environmentId: "master",
      });

      expect(result).toBe("blogPost");
    });
  });
});
