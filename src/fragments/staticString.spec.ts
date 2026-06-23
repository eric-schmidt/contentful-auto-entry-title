import { describe, it, expect } from "vitest";
import { staticString } from "./staticString";
import { mockEmitter } from "./testEmitter";

describe("staticString", () => {
  it("emits the fixed value once on subscribe", () => {
    const emit = mockEmitter();
    const teardown = staticString("Auto Title").subscribe({
      sdk: {} as never,
      emit,
    });

    expect(emit).toHaveBeenCalledExactlyOnceWith("Auto Title");
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
  });

  it("compute returns the fixed value", async () => {
    const result = await staticString("Auto Title").compute({
      entry: {} as never,
      cma: {} as never,
      defaultLocale: "en-US",
      environmentId: "master",
    });

    expect(result).toBe("Auto Title");
  });
});
