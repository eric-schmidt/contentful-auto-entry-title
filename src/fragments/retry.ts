// Purpose: the mechanics of "try, wait, try again", and nothing else.
//
// Two paths need it — the editor's ScheduledAction lookup
// (./publicationDate.ts) and the Function's release fetch
// (functions/handler/releaseDate.ts) — because Contentful fires `Release.save`
// before the release-side state it describes is fully queryable.
//
// Deliberately NOT shared: the delay ladders, what counts as success, whether a
// throw is fatal, and the logging. Those differ between the two callers and the
// differences are load-bearing:
//
//   - `publicationDate` does not catch. A throw propagates to `composeTitle`'s
//     per-fragment catch, which substitutes "". Its retries are also opt-in,
//     because retrying an empty result punishes every entry that legitimately
//     has no schedule — that cost 60 of 110 CMA requests in one fan-out against
//     a ~7 req/s limit.
//   - `safeReleaseGetWithMembers` catches per attempt and abandons immediately
//     on a thrown fetch, because a 404 means the release is gone and waiting
//     cannot help.
//
// So this file owns the loop and the sleeping. Callers keep everything that
// encodes a policy. Lives in `src/` because `src/` must never import from
// `functions/` — only the reverse, as `functions/shared/conceptReaderForFunction.ts`
// already does.

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Runs `attempt` once per entry in `delays`, sleeping for that entry's value
// first (a leading `0` therefore means "start immediately"). Stops as soon as
// `isDone` accepts a result; when the ladder runs out, returns the LAST result
// rather than throwing — every caller so far has a sensible degraded reading of
// "still not there", and hiding it behind an exception would only move the
// branch.
//
// `delays` must not be empty: with nothing to iterate there is no result to
// return, which is a mistake in the caller's constant rather than a runtime
// condition. Use `[0]` for "attempt once, no retries".
export const retryOverDelays = async <T>(
  delays: readonly number[],
  attempt: () => Promise<T>,
  isDone: (result: T) => boolean,
): Promise<T> => {
  if (delays.length === 0) {
    throw new Error("retryOverDelays: `delays` must contain at least one entry");
  }

  let last: T;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    last = await attempt();
    if (isDone(last)) return last;
  }
  // Safe: `delays` is non-empty, so the loop assigned at least once.
  return last!;
};
