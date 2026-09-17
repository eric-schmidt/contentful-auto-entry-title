// Purpose: Fragment that prefixes the title with the formatted scheduled
// date of any Launch Release the entry sits in (e.g. "Jul-04"). This is the
// most complex fragment because it has to chase a two-hop CMA path
// (entry → release → scheduled-action) AND tolerate Contentful's read-
// after-write consistency window; the retry constants and singular
// `entity.sys.id` filter below are both worked around here.

import type { FragmentCmaClient, Fragment } from "./types";
import { retryOverDelays } from "./retry";

// Formats an ISO 8601 instant as `Mon-DD` in the supplied IANA timezone (or UTC
// if none). Uses Intl.DateTimeFormat with locale "en-US" so the month
// abbreviation is deterministic regardless of the runtime locale.
export const formatPublicationDate = (
  iso: string,
  timezone?: string,
): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const fmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: timezone || "UTC",
  });
  // en-US short-month + 2-digit day produces "Jul 04" — replace the space
  // with our hyphen separator to land on "Jul-04".
  return fmt.format(date).replace(" ", "-");
};

type ScheduledActionItem = {
  sys?: { id?: string; status?: string };
  entity?: { sys?: { id?: string; linkType?: string } };
  scheduledFor?: { datetime?: string; timezone?: string };
};

// When a user schedules a Launch release, Contentful fires `Release.save`
// before the corresponding ScheduledAction entity is fully persisted. Without
// retries, our query at the moment Release.save fires returns 0 items even
// though the schedule will exist within the next second or so. Max ~3.75s
// total wait.
//
// These retries are OPT-IN (`awaitScheduleConsistency`), and that matters for
// more than latency. The loop retries on an *empty* result, but "empty" is also
// the correct, permanent answer for any entry that simply isn't scheduled — so
// when applied indiscriminately every unscheduled entry paid all 5 attempts to
// learn nothing. Across a publish fan-out that was the largest single source of
// CMA 429s: 60 of 110 requests for 12 parent entries, against a 7 req/s limit.
//
// Only a caller with independent evidence that a schedule should exist — i.e.
// the Release.* / ScheduledAction.* branch, where the event itself is that
// evidence — can distinguish "not queryable yet" from "not scheduled". So only
// that branch opts in.
const SCHEDULE_LOOKUP_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000];
const NO_RETRY_DELAYS_MS = [0];

const fetchMatchingScheduledActions = async (
  cma: FragmentCmaClient,
  releaseIds: string[],
  environmentId: string,
): Promise<ScheduledActionItem[]> => {
  const releaseIdSet = new Set(releaseIds);

  // Contentful's scheduled-actions endpoint silently ignores `entity.sys.id[in]`
  // — the documented filter is `entity.sys.id` (singular). For multiple
  // releases we issue one query per release id and merge the results.
  const perReleaseResponses = await Promise.all(
    releaseIds.map((releaseId) =>
      cma.scheduledActions.getMany({
        query: {
          "entity.sys.id": releaseId,
          "entity.sys.linkType": "Release",
          "environment.sys.id": environmentId,
          "sys.status": "scheduled",
        },
      }),
    ),
  );

  return perReleaseResponses
    .flatMap((r) => r.items)
    .filter(
      (a) =>
        a.entity?.sys?.linkType === "Release" &&
        typeof a.entity?.sys?.id === "string" &&
        releaseIdSet.has(a.entity.sys.id),
    );
};

const findScheduledDateForEntry = async (
  cma: FragmentCmaClient,
  entryId: string,
  environmentId: string,
  // See SCHEDULE_LOOKUP_RETRY_DELAYS_MS: only pass true when something else
  // already tells you a schedule ought to exist.
  awaitScheduleConsistency = false,
): Promise<string> => {
  // Restrict to active (non-archived) releases. Archived releases can still
  // have an attached ScheduledAction with `sys.status: "scheduled"`, so
  // without this filter the date prefix would persist on entries whose
  // release was archived. The defensive client-side filter below guards
  // against any future query-parser regression silently widening the result.
  const releases = await cma.release.query({
    query: {
      "entities.sys.id[in]": entryId,
      "entities.sys.linkType": "Entry",
      "sys.status[in]": "active",
    },
  });
  const activeReleases = releases.items.filter(
    (r) => (r.sys as { status?: string } | undefined)?.status === "active",
  );
  if (!activeReleases.length) return "";

  const releaseIds = activeReleases.map((r) => r.sys.id);

  // No catch, on purpose: a throw here reaches `composeTitle`'s per-fragment
  // catch, which substitutes "". See ./retry.ts.
  const filteredItems = await retryOverDelays(
    awaitScheduleConsistency
      ? SCHEDULE_LOOKUP_RETRY_DELAYS_MS
      : NO_RETRY_DELAYS_MS,
    () => fetchMatchingScheduledActions(cma, releaseIds, environmentId),
    (items) => items.length > 0,
  );

  if (!filteredItems.length) return "";

  // If multiple Releases the entry sits in are scheduled, pick the earliest.
  const earliest = filteredItems
    .map((a) => ({
      datetime: a.scheduledFor?.datetime,
      timezone: a.scheduledFor?.timezone,
    }))
    .filter((a) => typeof a.datetime === "string" && a.datetime.length > 0)
    .sort((a, b) =>
      (a.datetime as string).localeCompare(b.datetime as string),
    )[0];

  if (!earliest || !earliest.datetime) return "";
  return formatPublicationDate(earliest.datetime, earliest.timezone);
};

// `publicationDate` runs the same CMA lookup in both `subscribe` (editor
// session) and `compute` (App Event handler). Releases aren't reflected on
// the entry's own fields and there's no SDK signal for "this entry was added
// to a scheduled Release", so the editor has no way to react live to schedule
// changes — but it can still read the current state on mount, so the editor's
// emitted value matches the persisted title and other-fragment edits don't
// strip the date. The handler function performs the same lookup when a
// Release event fires elsewhere.
export const publicationDate = (): Fragment => ({
  subscribe: ({ sdk, emit }) => {
    let cancelled = false;
    findScheduledDateForEntry(
      sdk.cma,
      sdk.ids.entry,
      sdk.ids.environmentAlias ?? sdk.ids.environment,
    )
      .then((value) => {
        if (!cancelled) emit(value);
      })
      .catch(() => {
        if (!cancelled) emit("");
      });
    return () => {
      cancelled = true;
    };
  },
  compute: async ({ entry, cma, environmentId, awaitScheduleConsistency }) =>
    findScheduledDateForEntry(
      cma,
      entry.sys.id,
      environmentId,
      awaitScheduleConsistency,
    ),
});
