# Publication date fragment

Releases and Scheduled Actions. This is the most architecturally nuanced piece
of the app — read it in full before changing
`src/fragments/publicationDate.ts` or `functions/handler/releaseDate.ts`.

## Releases vs. Scheduled Actions: the data model

There are **two separate Contentful entities** at play, and conflating them is
the most common mistake:

- A **Release** (Launch Release) is a **container** of entries and assets, with a
  hard limit of 200 entities. Mutating its membership produces `Release.create` /
  `Release.save` / `Release.delete`.
- A **ScheduledAction** is a **separate, independent entity** saying "publish
  this thing at this time." Its `entity` field links to an `Entry`, an `Asset`,
  or — critically here — a **`Release`**. Mutating it produces
  `ScheduledAction.create` / `.save` / `.delete`.
- A "scheduled Launch Release" is therefore a Release **plus** a ScheduledAction
  whose `entity.sys.linkType === "Release"`. The timestamp lives on the
  ScheduledAction's `scheduledFor.datetime` (ISO 8601), with an optional IANA
  `scheduledFor.timezone` (default UTC).

**Critical implication:** rescheduling, unscheduling, and "is this Release
scheduled?" all operate on the ScheduledAction, **not** on the Release. Calling
`release.update` does not change a Release's schedule.

Two query quirks are worked around in `fetchMatchingScheduledActions`: the
ScheduledActions filter is `entity.sys.id` (**singular**), and its `[in]`
variant is **silently ignored** by the CMA — so it issues one request per release
id.

## Why this fragment needs both `subscribe` and `compute`

The editor has **no SDK signal** that an entry has been added to a scheduled
Launch Release. Releases are not reflected on the entry's own fields, and the
schedule isn't on the Release either. So the editor cannot react _live_ to a
schedule change made in another tab or by another user.

But the editor still needs the date in the title:

- On entry mount, so the title doesn't lose the date when the editor edits the
  description and triggers a recompute.
- After a deploy, when no App Event has fired (nothing changed) but a fresh
  editor session is reading the entry.

So **`publicationDate.subscribe` runs the same CMA lookup that `compute` runs.**
On mount it queries `release.query` + `scheduledActions.getMany` once, finds the
relevant scheduled date if any, and emits it. The composed title then matches
the persisted title, so the equality guard in `Field.tsx` short-circuits and
nothing is written. When the editor later edits another field, the
`publicationDate` slot still holds the date in memory, so the composed write
keeps it.

The App Event handler runs the same lookup server-side when a Release or
ScheduledAction event fires, propagating updates to closed entries. **Two paths,
one lookup helper, one source of truth.**

### Accepted staleness window

If a Release is scheduled or rescheduled in another tab while the editor is
open, `subscribe` has already fired with the old (or no) value — the in-memory
slot won't update until the entry is reopened. During that window an
editor-side write (an edit to description, say) produces a title without the new
date. The App Event handler still fires on the schedule event and corrects the
persisted title; reopening shows the corrected value. This is the same staleness
window every cross-entry fragment has, and it is intentional — don't add polling.

## State transitions and the events that signal them

| Transition                           | Triggering event(s)                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Entry added to a Release             | `Release.save` (recomputes all current members)                                                     |
| Entry removed from a Release         | `Release.save` — but see the limitation below                                                       |
| Release scheduled for the first time | `ScheduledAction.create` (`entity.sys.linkType === "Release"`)                                      |
| Release rescheduled                  | `ScheduledAction.save` (same filter)                                                                |
| Release unscheduled                  | `ScheduledAction.delete` (same filter)                                                              |
| Release archived                     | `Release.archive` — refetch (archived releases stay queryable) and recompute; the date prefix drops |
| Release unarchived                   | `Release.unarchive` — refetch and recompute; the prefix returns if a ScheduledAction survived       |
| Release deleted                      | `Release.delete` — read entities from the **event body** and recompute                              |

## Why there is a retry loop

Contentful fires `Release.save` **before** the corresponding ScheduledAction and
release-member state are fully queryable. Both paths therefore retry over a
`[0, 250, 500, 1000, 2000]` ms ladder (max ~3.75s) using `retryOverDelays` from
`src/fragments/retry.ts`. The mechanics are shared; the policies deliberately are
not:

- **`publicationDate`'s retries are opt-in** (`awaitScheduleConsistency`). The
  loop retries on an _empty_ result, but "empty" is also the correct, permanent
  answer for any entry that simply isn't scheduled — so applied indiscriminately,
  every unscheduled entry paid all five attempts to learn nothing. Across a
  publish fan-out that was the largest single source of CMA 429s: **60 of 110
  requests for 12 parent entries**, against a ~7 req/s limit. Only a caller with
  independent evidence that a schedule should exist — the `Release.*` /
  `ScheduledAction.*` branch, where the event itself is that evidence — can
  distinguish "not queryable yet" from "not scheduled", so only that branch opts
  in.
- **`safeReleaseGetWithMembers` abandons immediately on a thrown fetch.** A 404
  means the release is gone and waiting cannot help. Exhausting the ladder is
  different: it yields the last response, members or not.
- **`publicationDate` does not catch at all.** A throw propagates to
  `composeTitle`'s per-fragment catch, which substitutes `""`.

## Date format and timezone

The fragment is `Mon-DD` — 3-character month abbreviation, 2-digit day,
hyphen-separated, no year (`Jul-04`, `Dec-29`). The calendar date is computed in
the ScheduledAction's `scheduledFor.timezone` if present, otherwise in UTC.

This is documented because the timezone semantics of "what calendar date is this
scheduled for" are not obvious. A release scheduled for `2026-07-04T03:00:00Z`
with `scheduledFor.timezone === "America/Los_Angeles"` shows as `Jul-03`, not
`Jul-04` — at 3 AM UTC on July 4 it is still 8 PM on **July 3** in LA.

## Setup

Subscription wiring is in the README's
[One-time setup](../README.md#one-time-setup). A single subscription on
`autoEntryTitleHandler` covers both linked-entry rename propagation and Release
lifecycle events; the Release/ScheduledAction topics here are part of that one
topic list. Dispatch mechanics are in
[Server-side propagation](./server-side-propagation.md).

## Adding more fragments like this

If a future fragment's value comes from outside the entry, follow the same
pattern: **a single helper** taking a CMA client plus the relevant ids and
returning the formatted string, called from both `subscribe` and `compute`. See
[Title composition](./title-composition.md#authoring-a-new-fragment) for the full
contract.

The other worked example is
[`conceptNotation`](./taxonomy-notation.md) — the only fragment that reads
`metadata` rather than `fields`, and the only one needing a capability the shared
`FragmentCmaClient` cannot provide. Copy that one if your fragment's data lives
off the entry's fields or off the space-scoped CMA.
