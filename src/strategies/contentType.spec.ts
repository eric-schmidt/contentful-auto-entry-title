import { describe, it, expect, vi } from "vitest";
import { contentType } from "./contentType";

const buildSdk = (overrides: { name?: string; id?: string }) =>
  ({
    contentType: {
      name: overrides.name,
      sys: { id: overrides.id ?? "blogPost" },
    },
  }) as unknown as Parameters<ReturnType<typeof contentType>>[0]["sdk"];

describe("contentType", () => {
  it("emits the content type display name on mount", () => {
    const emit = vi.fn();
    const teardown = contentType()({
      sdk: buildSdk({ name: "Blog Post", id: "blogPost" }),
      emit,
    });

    expect(emit).toHaveBeenCalledExactlyOnceWith("Blog Post");
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
  });

  it("falls back to sys.id when the display name is missing", () => {
    const emit = vi.fn();
    contentType()({
      sdk: buildSdk({ name: undefined, id: "blogPost" }),
      emit,
    });

    expect(emit).toHaveBeenCalledExactlyOnceWith("blogPost");
  });
});
