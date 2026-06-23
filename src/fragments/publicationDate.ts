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

const findScheduledDateForEntry = async (
  cma: FragmentCmaClient,
  entryId: string,
  environmentId: string,
): Promise<string> => {
  const releases = await cma.release.query({
    query: {
      "entities.sys.id[in]": entryId,
      "entities.sys.linkType": "Entry",
    },
  });
  if (!releases.items.length) return "";

  const releaseIds = releases.items.map((r) => r.sys.id);
  const scheduled = await cma.scheduledActions.getMany({
    query: {
      "entity.sys.id[in]": releaseIds.join(","),
      "entity.sys.linkType": "Release",
      "environment.sys.id": environmentId,
      "sys.status": "scheduled",
    },
  });
  if (!scheduled.items.length) return "";

  // If multiple Releases the entry sits in are scheduled, pick the earliest.
  const earliest = scheduled.items
    .map((a) => ({
      datetime: a.scheduledFor.datetime,
      timezone: a.scheduledFor.timezone,
    }))
    .filter((a) => typeof a.datetime === "string")
    .sort((a, b) => a.datetime.localeCompare(b.datetime))[0];

  if (!earliest) return "";
  return formatPublicationDate(earliest.datetime, earliest.timezone);
};

// `publicationDate` runs the same CMA lookup in both `subscribe` (editor
// session) and `compute` (App Event handler). Releases aren't reflected on
// the entry's own fields and there's no SDK signal for "this entry was added
// to a scheduled Release", so the editor has no way to react live to schedule
// changes — but it can still read the current state on mount, so the editor's
// emitted value matches the persisted title and other-fragment edits don't
// strip the date. The handler function performs the same lookup when a
// Release or ScheduledAction event fires elsewhere.
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
