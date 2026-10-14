import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mapWithConcurrency, withRateLimitRetry } from "./rateLimit";

// The two failure shapes this helper has to cope with, which differ by runtime:
//
//   - `httpError`: the editor path. sdk-core's error-handler throws an Error
//     whose `name` is the CMA error id and whose `message` is a JSON blob. A
//     real axios failure also carries `response.headers`.
//   - `opaqueError`: a Function. `context.cma` rejections can arrive as just
//     `{ remote: true }` — no status, no headers.
const httpError = (status: number, resetSeconds?: number) => {
  const err = new Error(
    JSON.stringify({ status, message: "rate limit" }),
  ) as Error & {
    response?: { status: number; headers: Record<string, string> };
  };
  err.name = status === 429 ? "RateLimitExceeded" : `${status}`;
  err.response = {
    status,
    headers:
      resetSeconds === undefined
        ? {}
        : { "x-contentful-ratelimit-reset": String(resetSeconds) },
  };
  return err;
};

const opaqueError = () => ({ remote: true });

describe("withRateLimitRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin jitter so waits are arithmetic rather than a range.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    // Order matters: `restoreAllMocks` must undo the `setTimeout` spy while
    // fake timers are still installed. Reversed, it restores the spy onto the
    // FAKE setTimeout, which then leaks into every later test as a timer that
    // never fires.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // The helper awaits `sleep`, so fake timers must be driven for it to
  // progress. The no-op catch is attached FIRST: a rejecting call would
  // otherwise settle during `runAllTimersAsync` with no handler yet and be
  // reported as an unhandled rejection. The original promise is still returned,
  // so assertions see the real outcome.
  const run = <T>(promise: Promise<T>): Promise<T> => {
    promise.catch(() => {});
    return vi.runAllTimersAsync().then(() => promise);
  };

  it("returns the first successful result without sleeping", async () => {
    const fn = vi.fn(async () => "ok");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const result = await run(withRateLimitRetry(fn, { context: "spec" }));

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("honours x-contentful-ratelimit-reset as SECONDS on a 429", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429, 2))
      .mockResolvedValueOnce("ok");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const result = await run(withRateLimitRetry(fn, { context: "spec" }));

    expect(result).toBe("ok");
    // 2s from the header, + 500ms, + 0 jitter. Crucially ~2500 and not ~2ms,
    // which is what reading the header as milliseconds would give.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2500);
  });

  it("falls back to sqrt(2)^attempt when the reset header is absent", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce("ok");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await run(withRateLimitRetry(fn, { context: "spec" }));

    // sqrt(2)^1 * 1000 + 500 = 1914; sqrt(2)^2 * 1000 + 500 = 2500.
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      1914,
    );
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      2500,
    );
  });

  it("retries 5xx and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValueOnce("ok");

    await expect(
      run(withRateLimitRetry(fn, { context: "spec" })),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 409 conflict", async () => {
    // A stale sys.version cannot be fixed by replaying the same patch.
    const fn = vi.fn().mockRejectedValue(httpError(409));

    await expect(
      run(withRateLimitRetry(fn, { context: "spec" })),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 404", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(404));

    await expect(
      run(withRateLimitRetry(fn, { context: "spec" })),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries an opaque { remote: true } Function rejection", async () => {
    // The case the helper exists for: a Function's CMA failures don't serialize
    // status or headers, so a 429 is indistinguishable from anything else. This
    // shape is retried blind because losing 429 handling in the runtime that
    // needs it most is the worse trade.
    const fn = vi
      .fn()
      .mockRejectedValueOnce(opaqueError())
      .mockResolvedValueOnce("ok");

    await expect(
      run(withRateLimitRetry(fn, { context: "spec" })),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry an unclassifiable plain Error", async () => {
    // A bug, not a rate limit. Retrying would multiply one logged per-entry
    // failure into several and spend the batch's time budget for no chance of a
    // different outcome. Note this is what keeps the existing
    // "continues the batch when one entry's patch fails" specs at one call.
    const fn = vi.fn().mockRejectedValue(new Error("version mismatch"));

    await expect(
      run(withRateLimitRetry(fn, { context: "spec" })),
    ).rejects.toThrow("version mismatch");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops at the retry ceiling and rejects with the last error", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(429, 0));

    await expect(
      run(withRateLimitRetry(fn, { context: "spec", maxRetries: 2 })),
    ).rejects.toThrow();
    // 1 initial attempt + 2 retries.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up early when the next wait would exceed the sleep budget", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValue(httpError(429, 5));

    await expect(
      run(
        withRateLimitRetry(fn, {
          context: "spec",
          sleepBudgetMs: 6000,
        }),
      ),
    ).rejects.toThrow();

    // First wait is 5500ms; a second would reach 11000ms and blow the 6000ms
    // budget, so it stops rather than sleeping past the Function's 30s kill.
    expect(fn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("rate-limit backoff"),
    );
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    // Deliberately inverted durations: later items finish first.
    const result = await mapWithConcurrency([30, 20, 10], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });

    expect(result).toEqual([30, 20, 10]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return i;
      },
    );

    expect(peak).toBe(3);
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];

    const result = await mapWithConcurrency(
      Array.from({ length: 25 }, (_, i) => i),
      4,
      async (i) => {
        seen.push(i);
        return i * 2;
      },
    );

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(result[24]).toBe(48);
  });

  it("handles an empty list without spawning workers", async () => {
    const fn = vi.fn();
    await expect(mapWithConcurrency([], 3, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a limit below 1", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(
      "at least 1",
    );
  });
});
