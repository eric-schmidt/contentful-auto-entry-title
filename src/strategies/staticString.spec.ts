import { describe, it, expect, vi } from "vitest";
import { staticString } from "./staticString";

describe("staticString", () => {
  it("emits the fixed value once on setup", () => {
    const emit = vi.fn();
    const teardown = staticString("Auto Title")({
      sdk: {} as never,
      emit,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("Auto Title");
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
  });
});
