This project was bootstrapped with [Create Contentful App](https://github.com/contentful/create-contentful-app).

## Overview

The main goal of this app is to automatically generate the value of an entry's title field by composing an ordered list of fragments — small modules that each contribute one piece of the final string (e.g., a value pulled from another field, a Launch Release scheduled date, a fixed prefix). Fragments are concatenated with a configurable separator and written to the field on which the app is mounted.

This app is intended for non-localized entry-title fields. The composed value is written via `sdk.field.setValue`, which targets the locale of the mounted field.

## Deployment

This app uses https://github.com/contentful/actions-app-deploy to automatically deploy to Contentful when changes are pushed up to GitHub. Configuration for this process can be found in the `.github/workflows/actions-app-deploy.yml` file.

## App/Content Type Configuration

1. Install the app to your space, either via Contentful hosting or by cloning this repo and running `npm install` and `npm start` (hosted at http://localhost:3000).
2. Enable for Short Text entry fields (the only field type currently supported).
3. Create a Short Text field on a content type and edit its appearance to use the Auto Entry Title widget.

## Configuring naming behavior

Naming behavior is composed from an ordered list of fragments in `src/fragments/index.ts`. Edit the `composition` export to add, remove, or reorder fragments, then rebuild and redeploy:

```ts
export const composition: FieldNameComposition = {
  fragments: [staticString("Auto Title")],
  separator: " - ",
};
```

A fragment is any object matching the `Fragment` signature in `src/fragments/types.ts`. Its `subscribe` method receives the SDK plus an `emit(fragment)` callback, subscribes to whatever it needs, and returns a teardown that removes its listeners. `Field.tsx` joins each fragment's most-recent emitted value with the separator and writes the result to the field (skipping the write when the composed value already matches).

## Server-side title propagation (App Event Subscription)

Some fragments derive their value from data outside the entry itself:

- **`referencedEntryTitle`** — title of a referenced Region. When the Region is renamed while a parent entry is closed, the parent's title would otherwise go stale.
- **`publicationDate`** — formatted date from the Launch Release the entry is in. The editor has no signal that an entry was added to a scheduled Release, so this fragment is populated entirely server-side.

Both behaviors are handled by a **single Contentful Function** — `autoEntryTitleHandler` (declared in `contentful-app-manifest.json`, source in `functions/handler/index.ts`). A Contentful App Definition supports only **one** App Event handler function, so the function is a thin **dispatcher** that inspects the incoming `X-Contentful-Topic` header and routes to per-domain modules:

| Topic | Routes to | What it does |
|---|---|---|
| `ContentManagement.Entry.publish` | `functions/handler/regionTitle.ts` | If the published entry is a `region`, find every entry that references it via `links_to_entry` and recompute their titles. |
| `ContentManagement.Release.create` / `.save` | `functions/handler/releaseDate.ts` | Fetch the Release, iterate its entry members, recompute each title (the `publicationDate` fragment will look up the schedule). |
| `ContentManagement.ScheduledAction.create` / `.save` / `.delete` | `functions/handler/releaseDate.ts` | Same as above, but only when `entity.sys.linkType === "Release"`. Schedule appears, changes, or disappears. |

For each managed parent, the dispatch path: locate the title field bound to this app via the entry's editor interface → recompute via `composeTitle` (the same composition the editor uses) → idempotency-skip if the new title matches the current → otherwise update the entry as a draft.

The function is **declared** in the manifest and **bundled** by `npm run build`, but it does not run until an **App Event Subscription** is created that points the relevant topics at this function. That subscription is a one-time, per-App-Definition setup. We do this manually via the Contentful web UI rather than scripting it.

### One-time setup

Do this once, after the app has been uploaded and activated for the first time. You'll need org admin access in Contentful.

1. In the Contentful web app, switch to the organization that owns this App Definition.
2. Open **Org Settings → Apps → [the "Auto Entry Title" app definition]**.
3. Open the **Events** tab.
4. Click **Create event subscription** (or "Add subscription" — wording varies).
5. **Topics**: enable all six —
   - `Entry.publish`
   - `Release.create`
   - `Release.save`
   - `ScheduledAction.create`
   - `ScheduledAction.save`
   - `ScheduledAction.delete`
6. **Target**: choose **Function**, then select `autoEntryTitleHandler` as the **App event handler**. Leave the filter and transformation function slots empty.
7. Save the subscription.

There is no content-type filter at the subscription level — the dispatcher filters `Entry.publish` down to content type `region` and `ScheduledAction.*` down to Release-targeted actions inside the handler itself, so subscribing to all six topics is correct and expected.

### Verifying the subscription

After saving:

1. In the Events tab, confirm the subscription is listed with all six topics → `autoEntryTitleHandler` as the handler.
2. **Region rename test:** in a sandbox space, create a `region` entry titled "EMEA", reference it from a parent entry. Confirm the parent's title fragment for the region shows "EMEA" (editor `subscribe` path, no function involvement). Close the parent. Rename the Region to "Europe" and publish it. Reopen the parent — its title should now reflect "Europe".
3. **Release schedule test:** create a Launch Release containing a managed entry, schedule it for some date. After the function runs, the entry's title should show the date prefix (e.g. `Jul-04 - …`). Reschedule, then unschedule — the title should update to the new date, then drop the date entirely.
4. If either test fails, check the **Function logs** for `autoEntryTitleHandler` in the same Events tab — they'll surface the topic that fired and any per-parent errors.

### Re-running / changing the subscription

The subscription persists at the App Definition level — redeploys of the function bundle do **not** require re-creating it. You only need to revisit this UI when:

- You change which topics the function should accept (e.g., add `Entry.unpublish` later).
- The subscription was accidentally deleted.

Editing the existing subscription in place is supported — toggle topics, change the target function, save.

### Required app permissions

For the function to read editor interfaces and update entries on parents, the App Definition must have CMA permissions sufficient for entry reads + writes. These are configured on the App Definition itself (also in the org-level App Definition settings), not in the Events tab. If the function logs `forbidden` or `unauthorized` errors, that's the place to check.

## Publication date fragment (Releases & Scheduled Actions)

This is the most architecturally nuanced piece of the app. If you are extending or debugging the publication-date behavior, read this section in full before changing any code in `src/fragments/publicationDate.ts`, `functions/handler/releaseDate.ts`, or the `emit.skip()` plumbing in `src/locations/Field.tsx`.

### Why this fragment is server-side only

The editor has **no SDK signal** that an entry has been added to a scheduled Launch Release. Releases are not reflected on the entry's own fields, and (as you'll see below) the schedule isn't even on the Release itself. So the editor's `subscribe` path emits nothing meaningful — all scheduling work happens in an App Event handler function.

This also means the editor must not clobber the date the function wrote on a previous run. We solve that with the `emit.skip()` mechanic described below.

### Releases vs. Scheduled Actions: the data model

There are **two separate Contentful entities** at play, and conflating them is the most common mistake:

- A **Release** (Launch Release) is a **container** of entries/assets. It has a hard limit of 200 entities. Mutating its membership produces `Release.create` / `Release.save` / `Release.delete` events.
- A **ScheduledAction** is a **separate, independent entity** that says "publish this thing at this time." Its `entity` field is a link to either an `Entry`, `Asset`, or — critically for this app — a **`Release`**. Mutating it produces `ScheduledAction.create` / `.save` / `.delete` events.
- A "scheduled Launch Release" is therefore a Release **plus** a ScheduledAction whose `entity.sys.linkType === "Release"`. The schedule timestamp lives on the ScheduledAction's `scheduledFor.datetime` (ISO 8601), with an optional IANA `scheduledFor.timezone` (default: UTC).

**Critical implication:** rescheduling, unscheduling, and "is this Release scheduled?" all operate on the ScheduledAction, NOT on the Release entity. Calling `release.update` does not change a Release's schedule.

### The four state transitions and the events that signal them

| Transition | Triggering event(s) |
|---|---|
| Entry added to / removed from a Release | `Release.save` |
| Release scheduled for the first time | `ScheduledAction.create` (`entity.sys.linkType === "Release"`) |
| Release rescheduled | `ScheduledAction.save` (same filter) |
| Release unscheduled (schedule canceled) | `ScheduledAction.delete` (same filter) |
| Release deleted | NOT subscribed — see below |

### Why we do not subscribe to `Release.delete`

When a Release is deleted, its ScheduledAction is also deleted, and `ScheduledAction.delete` typically fires while the Release still exists. Our handler iterates the Release's current members at that point and drops the date. If a Release is hard-deleted before that event reaches us, we lose the membership list and cannot reliably clean up — this is an **accepted edge case**. Do **not** "fix" this by subscribing to `Release.delete`: that event fires after the membership list is already gone, so it gives us nothing actionable.

### The `emit.skip()` / function-managed slot mechanic

Strategies fall into two categories:

- **Editor-derivable** fragments (`fieldValue`, `contentType`, `referencedEntryTitle`): the fragment's `subscribe` listens for an editor-side signal and emits a value. The editor is the source of truth for the slot.
- **Function-managed** fragments (`publicationDate`, and any future fragment that pulls from external systems with no editor-side signal): the function writes the value server-side via `compute`. The editor must respect that persisted value.

If a function-managed fragment's `subscribe` simply emitted `""`, the editor would re-mount, see an empty slot, recompute, and **silently overwrite** the date the function previously wrote.

`emit.skip()` is the explicit signal: "this slot has no opinion right now." `Field.tsx` tracks slots in three states — string-with-value, empty-string, and `null` (skipped). While **any** slot is `null`, `Field.tsx` does not write to the field at all, regardless of what other slots have emitted. The persisted value stays put.

**When to use:** any fragment whose value is determined entirely server-side and the editor has no way to detect changes during the editing session. **When NOT to use:** any fragment where the editor can derive the value live from fields/metadata it can observe.

### The editor's role in this fragment

Practically: zero. The editor reads the persisted title back into the field, and `subscribe` for `publicationDate` calls `emit.skip()`. Edits to other fragments (description, regions) trigger their own emits and `Field.tsx` tries to recompute — but because the publicationDate slot is `null`, no write happens. Only the function ever writes the date. The persisted value is what editors see and what survives across remounts.

### Setup

Subscription wiring is documented above in **"Server-side title propagation (App Event Subscription)"** — a single subscription on `autoEntryTitleHandler` covers both Region renames and Release schedule events. The five Release/ScheduledAction topics in this section are part of that single subscription's topic list.

### Date format and timezone

The fragment is `Mon-DD` (3-character month abbreviation, 2-digit day, hyphen-separated, no year — e.g. `Jul-04`, `Dec-29`). The calendar date is computed in the ScheduledAction's `scheduledFor.timezone` if present, otherwise in UTC.

This is documented because timezone semantics for "what calendar date is this scheduled for" are not obvious. A release scheduled for `2026-07-04T03:00:00Z` with `scheduledFor.timezone === "America/Los_Angeles"` shows up as `Jul-03`, not `Jul-04`, because at 3 AM UTC on July 4 it is still 8 PM **July 3** in LA.

### Recursion safety

The function will not loop on Release schedule events:

- The dispatcher only routes `Release.*` and `ScheduledAction.*` topics into the schedule handler. Entry updates via `cma.entry.update` produce `Entry.save`, not `Release.save` or `ScheduledAction.*`, so writes from the schedule handler do not feed back into it.
- The dispatcher's `Entry.publish` route is gated on content type `region`. Title rewrites on managed parents produce `Entry.save` (not `Entry.publish`), and even if they did publish, they wouldn't be of type `region`.
- The idempotency guard (skip the CMA write when the new title matches the current) prevents redundant writes even if the same event re-fires.

### Shared utilities

The dispatcher and its per-domain modules use:

- `functions/shared/findManagedTitleFieldId.ts` — locates the title field on a parent entry's editor interface that is bound to this app, returning `null` for unmanaged content types. Also exports `resolveDefaultLocale`.
- `functions/shared/recomputeTitleForEntries.ts` — the per-parent loop: locate the managed title field, recompute via `composeTitle`, idempotency-skip, write as a draft. Both `regionTitle.ts` and `releaseDate.ts` end with a call to this helper.
- `src/fragments/compose.ts` — `composeTitle` is the single source of truth for "what should this entry's title be right now."

If you add a new dispatch route, follow the same shape: identify the affected entries, then call `recomputeTitleForEntries` with the list. Don't reimplement the per-parent loop or skip the idempotency guard — they're part of the contract.

## Available Scripts

In the project directory, you can run:

#### `npm start`

Creates or updates your app definition in Contentful, and runs the app in development mode.
Open your app to view it in the browser.

The page will reload if you make edits.
You will also see any lint errors in the console.

#### `npm run build`

Builds the app for production to the `build` folder.
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.
Your app is ready to be deployed!

#### `npm run upload`

Uploads the build folder to contentful and creates a bundle that is automatically activated.
The command guides you through the deployment process and asks for all required arguments.
Read [here](https://www.contentful.com/developers/docs/extensibility/app-framework/create-contentful-app/#deploy-with-contentful) for more information about the deployment process.

#### `npm run upload-ci`

Similar to `npm run upload` it will upload your app to contentful and activate it. The only difference is  
that with this command all required arguments are read from the environment variables, for example when you add
the upload command to your CI pipeline.

For this command to work, the following environment variables must be set:

- `CONTENTFUL_ORG_ID` - The ID of your organization
- `CONTENTFUL_APP_DEF_ID` - The ID of the app to which to add the bundle
- `CONTENTFUL_ACCESS_TOKEN` - A personal [access token](https://www.contentful.com/developers/docs/references/content-management-api/#/reference/personal-access-tokens)

## Libraries to use

To make your app look and feel like Contentful use the following libraries:

- [Forma 36](https://f36.contentful.com/) – Contentful's design system
- [Contentful Field Editors](https://www.contentful.com/developers/docs/extensibility/field-editors/) – Contentful's field editor React components

## Using the `contentful-management` SDK

In the default create contentful app output, a contentful management client is
passed into each location. This can be used to interact with Contentful's
management API. For example

```js
// Use the client
cma.locale.getMany({}).then((locales) => console.log(locales));
```

Visit the [`contentful-management` documentation](https://www.contentful.com/developers/docs/extensibility/app-framework/sdk/#using-the-contentful-management-library)
to find out more.

## Learn More

[Read more](https://www.contentful.com/developers/docs/extensibility/app-framework/create-contentful-app/) and check out the video on how to use the CLI.
