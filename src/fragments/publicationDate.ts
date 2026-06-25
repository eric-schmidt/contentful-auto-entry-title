import type { FragmentCmaClient, Fragment } from "./types";

// Formats an ISO 8601 instant as `Mon-DD` in the supplied IANA timezone (or UTC
// if none). Uses Intl.DateTimeFormat with locale "en-US" so the month
// abbreviation is deterministic regardless of the runtime locale.
export const formatPublicationDate = (iso: string, timezone?: string): string => {
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
const SCHEDULE_LOOKUP_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  let filteredItems: ScheduledActionItem[] = [];
  for (const delay of SCHEDULE_LOOKUP_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    filteredItems = await fetchMatchingScheduledActions(
      cma,
      releaseIds,
      environmentId,
    );
    if (filteredItems.length > 0) break;
  }

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
  compute: async ({ entry, cma, environmentId }) =>
    findScheduledDateForEntry(cma, entry.sys.id, environmentId),
});
