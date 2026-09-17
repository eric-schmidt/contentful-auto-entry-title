import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retryOverDelays, sleep } from "./retry";

describe("sleep", () => {
  it("resolves after the given delay", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const pending = sleep(50).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(49);
      expect(done).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retryOverDelays", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Drives a call to completion under fake timers: the loop awaits `sleep`, so
  // real time never passes and the timers have to be pushed along.
  const run = async <T>(promise: Promise<T>): Promise<T> => {
    await vi.runAllTimersAsync();
    return promise;
  };

  it("returns the first accepted result without further attempts", async () => {
    const attempt = vi.fn(async () => "found");

    const result = await run(
      retryOverDelays([0, 250, 500], attempt, (r) => r === "found"),
    );

    expect(result).toBe("found");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries until the result is accepted", async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      return calls === 3 ? "found" : "";
    });

    const result = await run(
      retryOverDelays([0, 250, 500, 1000], attempt, (r) => r !== ""),
    );

    expect(result).toBe("found");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  // The behaviour both callers depend on: an exhausted ladder degrades to the
  // last reading rather than throwing.
  it("returns the last result when the ladder is exhausted", async () => {
    let calls = 0;
    const attempt = vi.fn(async () => `attempt-${(calls += 1)}`);

    const result = await run(
      retryOverDelays([0, 250, 500], attempt, () => false),
    );

    expect(result).toBe("attempt-3");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("sleeps for each non-zero delay and skips a leading zero", async () => {
    const attempt = vi.fn(async () => "");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await run(retryOverDelays([0, 250, 500], attempt, () => false));

    const waits = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(waits).toEqual([250, 500]);
  });

  it("attempts exactly once for a single-entry ladder", async () => {
    const attempt = vi.fn(async () => "");

    await run(retryOverDelays([0], attempt, () => false));

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  // Callers keep their own error policy, so a throw must surface untouched —
  // `publicationDate` relies on it reaching `composeTitle`'s catch.
  it("propagates a thrown attempt without retrying", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("boom");
    });

    // The assertion is attached before the timers are advanced, so the
    // rejection is never briefly unhandled.
    const assertion = expect(
      retryOverDelays([0, 250], attempt, () => true),
    ).rejects.toThrow("boom");
    await vi.runAllTimersAsync();
    await assertion;

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty ladder as a caller mistake", async () => {
    await expect(
      retryOverDelays([], async () => "x", () => true),
    ).rejects.toThrow("at least one entry");
  });
});
