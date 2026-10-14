// Purpose: 429 handling for CMA writes, plus the bounded-parallel map that
// keeps request volume under the ~7 req/s cap in the first place.
//
// Why this is hand-written rather than an SDK option — verified against
// contentful-management 12.8.0 / contentful-sdk-core 9.x, because the obvious
// review question is "doesn't the SDK already do this?":
//
// It does, but only for clients IT builds. `contentful-sdk-core`'s retry is an
// axios *interceptor* (`rateLimit()` in create-http-client.js), and the only
// caller of `createHttpClient` is `RestAdapter`. `createAdapter` short-circuits
// before ever reaching it:
//
//     if ('apiAdapter' in params) { return params.apiAdapter }
//     else { return new RestAdapter(params) }
//
// `sdk.cma` (a postMessage adapter) and `context.cma` (host-provided,
// fetch-backed) are both `apiAdapter` clients, so no axios instance exists and
// no interceptor is installed. `retryOnError` / `retryLimit` / `throttle` aren't
// merely ignored there — `ClientOptions` is `XOR<RestAdapterParams,
// AdapterParams>`, so passing them alongside `apiAdapter` is a TYPE ERROR.
// Building our own REST client isn't an escape either: 12.8.0 ships only an
// axios adapter, which is why `context.cmaClientOptions` + `createClient`
// throws `Unknown adapter 'fetch'` in the Functions runtime (see
// ../handler/index.ts), and in the editor it would mean a management token in
// the browser bundle.
//
// So the policy below deliberately MIRRORS sdk-core's rate-limit.js rather than
// inventing one: same statuses, same header, same exponential shape. If the SDK
// ever becomes reachable here, the behaviour it replaces should look familiar.
//
// Distinct from ../../src/fragments/retry.ts, which retries on an unsatisfactory
// VALUE (a read-after-write consistency window). A 429 is a throw, so that
// helper re-throws it on the first attempt and cannot serve this purpose.

import { sleep } from "../../src/fragments/retry";

// Matches sdk-core's default `retryLimit` of 5 (6 attempts total).
const DEFAULT_MAX_RETRIES = 5;

// Functions are killed at 30s with no retry and no error. sdk-core's ladder can
// sleep ~18s on its own, which would burn the whole invocation waiting. This
// caps total time spent ASLEEP (not total runtime) so a rate-limited batch
// gives up in time to return what it already did, rather than being truncated
// mid-flight. It is a backstop: the caller's batching is the real fix.
const DEFAULT_SLEEP_BUDGET_MS = 10_000;

// sdk-core reads only `x-contentful-ratelimit-reset`, in SECONDS. It does NOT
// read `Retry-After`, so neither do we.
const RESET_HEADER = "x-contentful-ratelimit-reset";

type RetryOptions = {
  // Identifies the flow in log lines, matching the other shared helpers.
  context: string;
  maxRetries?: number;
  sleepBudgetMs?: number;
};

// A status we could actually read off the failure, or null when the error shape
// gave us nothing (which is the common case inside a Function).
const statusFrom = (err: unknown): number | null => {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    name?: unknown;
    message?: unknown;
  };

  for (const candidate of [e.status, e.statusCode, e.response?.status]) {
    if (typeof candidate === "number") return candidate;
  }

  // The editor path throws an Error whose `name` is the CMA error id and whose
  // `message` is a JSON blob carrying `status` (sdk-core's error-handler.js).
  if (e.name === "RateLimitExceeded") return 429;
  if (typeof e.message === "string") {
    try {
      const parsed = JSON.parse(e.message) as { status?: unknown };
      if (typeof parsed.status === "number") return parsed.status;
    } catch {
      // Not a JSON message; nothing to learn.
    }
  }

  return null;
};

// Headers are only present when the failure carried a real HTTP response, which
// a Function's opaque `{ remote: true }` rejection does not.
const resetSecondsFrom = (err: unknown): number | null => {
  if (typeof err !== "object" || err === null) return null;
  const headers = (err as { response?: { headers?: unknown } }).response
    ?.headers;
  if (typeof headers !== "object" || headers === null) return null;

  const raw = (headers as Record<string, unknown>)[RESET_HEADER];
  const seconds = typeof raw === "string" ? Number(raw) : raw;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds
    : null;
};

// A `context.cma` failure inside a Function does not serialize its status or
// headers across the remote boundary — the rejection arrives as an opaque
// `{ remote: true }`. Since that is the runtime this helper primarily protects,
// refusing to retry an unreadable error would mean never retrying the 429s it
// exists for. So this ONE shape is retried blind.
//
// The cost, stated plainly: a 409 conflict arriving opaquely is retried too, and
// a version-pinned patch cannot succeed on replay. That is bounded (the ceiling
// and the sleep budget) and it fails the same way in the end, whereas losing 429
// handling would not be bounded. If the runtime ever starts serializing status,
// prefer `statusFrom` and delete this branch.
const isOpaqueRemoteFailure = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { remote?: unknown }).remote === true;

// 409 is the failure we must never replay: `entry.patch` carries an explicit
// `sys.version`, so a conflict means our version is stale and the same request
// is doomed. It needs a re-fetch, which is the caller's decision. sdk-core
// doesn't retry conflicts either.
//
// A readable non-retryable status, and any other error we cannot classify (a
// plain `Error` from a bug, a rejected assertion), is NOT retried. Retrying
// those would turn one logged per-entry failure into several and burn the
// batch's time budget without any chance of a different outcome.
const isRetryable = (err: unknown): boolean => {
  const status = statusFrom(err);
  if (status === 429) return true;
  if (status !== null && status >= 500 && status < 600) return true;
  if (status !== null) return false;
  return isOpaqueRemoteFailure(err);
};

// sdk-core's formula: sqrt(2)^attempt seconds, then +500ms and up to 200ms of
// jitter so concurrent callers don't resynchronise on the same retry tick.
const backoffMs = (attempt: number, resetSeconds: number | null): number => {
  const base = resetSeconds ?? Math.SQRT2 ** attempt;
  return Math.floor(base * 1000 + Math.random() * 200 + 500);
};

// Runs `fn`, retrying rate-limit and transient failures. Rejects with the last
// error once the ceiling or the sleep budget is spent, so the caller still sees
// a real failure rather than a silent success.
export const withRateLimitRetry = async <T>(
  fn: () => Promise<T>,
  { context, maxRetries, sleepBudgetMs }: RetryOptions,
): Promise<T> => {
  const ceiling = maxRetries ?? DEFAULT_MAX_RETRIES;
  const budget = sleepBudgetMs ?? DEFAULT_SLEEP_BUDGET_MS;
  let slept = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt > ceiling || !isRetryable(err)) throw err;

      const wait = backoffMs(attempt, resetSecondsFrom(err));
      if (slept + wait > budget) {
        console.warn(
          `[auto-entry-title] ${context}: giving up after ${slept}ms of ` +
            `rate-limit backoff (next wait ${wait}ms would exceed the ` +
            `${budget}ms budget).`,
        );
        throw err;
      }

      slept += wait;
      await sleep(wait);
    }
  }
};

// Bounded-parallel map. Results keep INPUT order regardless of completion
// order, so callers can pair them back up with `items`.
//
// Concurrency is the other half of 429 avoidance: it caps how many requests are
// in flight, where `withRateLimitRetry` only reacts once we're already limited.
// A rejection from `fn` propagates — callers that need per-item tolerance catch
// inside `fn`, which is what `recomputeTitleForEntries` does so one bad entry
// can't abandon the batch.
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (limit < 1) {
    throw new Error("mapWithConcurrency: `limit` must be at least 1");
  }

  const results = new Array<R>(items.length);
  let next = 0;

  // Each worker pulls the next index until the list is exhausted. `next++` is
  // safe without a lock: only one worker runs between await points.
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );

  return results;
};
