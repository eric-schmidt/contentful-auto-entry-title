# Server-side propagation

Some fragments derive their value from data outside the entry itself:

- **`referencedEntryTitle`** — the title of a referenced Region. When the Region
  is renamed while a parent entry is closed, the parent's title would otherwise
  go stale.
- **`publicationDate`** — the formatted date of the Launch Release the entry is
  in. The editor has no signal that an entry was added to a scheduled Release,
  so this fragment is populated entirely server-side.

Both are handled by a **single Contentful Function**, `autoEntryTitleHandler`
(declared in `contentful-app-manifest.json`, source in
`functions/handler/index.ts`).

## Why the function is a dispatcher

A Contentful App Definition supports only **one** `appevent.handler` function.
So `index.ts` is a thin **dispatcher** that inspects the incoming
`X-Contentful-Topic` header and routes to per-domain modules. Do not split it
into separate event entry points.

> That cap applies to `appevent.handler` **only**. `appaction.call` functions are
> unrestricted, which is why the concept-repair action
> (`functions/handler/actions.ts`) is a second, separate function with its own
> bundle rather than another branch of this dispatcher — see
> [Propagating concept edits](./taxonomy-notation.md#propagating-concept-edits).

| Topic                                                                    | Routes to                               | What it does                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContentManagement.Entry.publish`                                        | `functions/handler/linkedEntryTitle.ts` | Recompute the **published entry's own** title, then find every entry that references it via `links_to_entry` and recompute those too. The second half drives rename propagation for every `referencedEntryTitle` fragment; the first covers a publish made from the Taxonomy tab, where the editor widget isn't mounted. Both are draft writes. |
| `ContentManagement.Release.create` / `.save` / `.archive` / `.unarchive` | `functions/handler/releaseDate.ts`      | Refetch the Release, iterate its entry members, recompute each title. Archive drops the date prefix; unarchive re-adds it if the ScheduledAction survived.                                                                                                                                                                                      |
| `ContentManagement.Release.delete`                                       | `functions/handler/releaseDate.ts`      | The release is gone by the time the event arrives, so the member list comes from the **event body's** `entities` array. Recompute those entries to drop the date prefix.                                                                                                                                                                        |
| `ContentManagement.ScheduledAction.create` / `.save` / `.delete`         | `functions/handler/releaseDate.ts`      | Same as `Release.save`, but only when `entity.sys.linkType === "Release"`. Schedule appears, changes, or disappears.                                                                                                                                                                                                                            |

## The dispatch path

For each managed entry: locate the title field bound to this app via the entry's
editor interface → recompute via `composeTitle` (the same composition the editor
uses) → idempotency-skip if the new title matches the current → otherwise
`cma.entry.patch`, which writes the **draft** only.

Two consequences of that last step, both deliberate. Patching a published entry
leaves it in **"Changed"** state, so a human has to publish again to make the
corrected title live. And because a draft write emits `Entry.save`, which this
dispatcher does not route, nothing the function writes can feed back into it.

There is no content-type filter at the subscription level — every
`Entry.publish` runs through `links_to_entry`, and `recomputeTitleForEntries`
only writes to entries whose title field is bound to this app. So unrelated
content types incur a single index lookup at most. `ScheduledAction.*` events
are filtered down to Release-targeted actions inside the handler. Subscribing to
all nine topics is correct and expected.

## Recursion safety

The function will not loop:

- The dispatcher routes only `Release.*`, `ScheduledAction.*` and
  `Entry.publish`. Entry writes via `cma.entry.patch` produce `Entry.save`, so
  writes from the schedule handler cannot feed back into it.
- Title rewrites produce `Entry.save`, not `Entry.publish`, so they don't
  re-enter the linked-entry rename path.
- This holds for the **published entry itself**, which the `Entry.publish` path
  includes in its recompute set. That correction is the same draft
  `cma.entry.patch` as any other.
- The idempotency guard (skip the write when the new title matches the current)
  prevents redundant writes even if the same event re-fires.

**The invariant to preserve: `cma.entry.patch` is the only CMA mutation in the
repo, and there are zero `.publish()` calls.** Adding one — to clear the
"Changed" badge automatically — would make the handler re-enter itself, and the
guard would become behavioural (the idempotency check) rather than structural. It
was considered and rejected for exactly that reason.

## Shared utilities

- **`functions/shared/findManagedTitleFieldId.ts`** — locates the title field on
  an entry's editor interface that is bound to this app, returning `null` for
  unmanaged content types. Also exports `resolveDefaultLocale`.
- **`functions/shared/recomputeTitleForEntries.ts`** — the per-entry loop:
  locate the managed title field, recompute via `composeTitle`,
  idempotency-skip, `cma.entry.patch` the draft. `linkedEntryTitle.ts`,
  `releaseDate.ts` and `actions.ts` all end with a call to this.
- **`functions/shared/paginateEntries.ts`** — the CMA offset-pagination loop.
  Callers build their own query (`links_to_entry` vs
  `metadata.concepts.sys.id[in]`); only the traversal is shared. It stops on a
  short page, guards a non-numeric `total`, and caps at 100 pages — the CMA
  independently caps `skip + limit` at 10,000.
- **`src/fragments/retry.ts`** — `sleep` plus `retryOverDelays`, the mechanics of
  a delay ladder. Callers keep their own delays, success condition, error policy
  and logging, because the editor and Function paths differ on all four.
- **`src/fragments/compose.ts`** — `composeTitle`, the single source of truth for
  "what should this entry's title be right now."

If you add a new dispatch route, follow the same shape: identify the affected
entries, then call `recomputeTitleForEntries` with the list. Don't reimplement
the per-entry loop or skip the idempotency guard — they are part of the contract.

### Entries reaching `compute` must be CMA-fetched

Never pass an App Event body snapshot. `conceptNotation.compute` reads
`entry.metadata?.concepts`, and zero concept ids resolves to `""` — **not**
`null` — so an entry without `metadata` composes a title missing the notation
blob, passes the `null` guard, and gets PATCHed over the correct one. An event
body is not guaranteed to carry `metadata`, and `FragmentComputeEntry` declares
`metadata?` optional with no `sys.version`, so passing `event.body` straight
through typechecks cleanly. `sys.version` on an event body is also already stale,
so the PATCH would 409 — and 409s are warned and swallowed, making the feature
look inert.

Every dispatch path hydrates first: see the re-fetch in `linkedEntryTitle.ts`
and the per-member hydration in `releaseDate.ts`.

### Forwarding optional context keys

`conceptReader` is an _optional_ fragment context key, so a dispatch branch that
forgets to thread it through **still compiles** and still writes titles — just
without maintaining that fragment's contribution. Every new dispatch branch must
forward it, and needs a test asserting so; `functions/handler/index.spec.ts`
invokes the forwarded reader and checks the CDA URL and `Authorization` header
it was built with.
