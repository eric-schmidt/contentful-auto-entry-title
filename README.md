This project was bootstrapped with [Create Contentful App](https://github.com/contentful/create-contentful-app).

## Overview

The main goal of this app is to automatically generate the value of an entry's title field by composing an ordered list of fragments — small modules that each contribute one piece of the final string (e.g., a value pulled from another field, a Launch Release scheduled date, a fixed prefix). Fragments are concatenated with a configurable separator and written to the field on which the app is mounted.

This app is intended for non-localized entry-title fields. The composed value is written via `sdk.field.setValue`, which targets the locale of the mounted field.

## Local Setup

1. Clone down this repo.
2. Ensure you are using a minimum of Node v22 (if using [NVM](https://github.com/nvm-sh/nvm) you can just run `nvm use` in the repo root).
3. Run `npm run build` to create the build directory that can be uploaded to Contentful.
4. You can run the *frontend* portion of this app locally using `npm run start`; however, the backend Functions have to be uploaded to Contentful in order to work properly (see next section).

## App Definition Setup
1. Navigate to your Contentful Organization overview and click on **Apps**.
2. Click **Create app** on the top right.
3. Add a **Title** and set the hosing URL to http://localhost:3000 for now (just so you can save the definition).
4. Under **Locations**, select **Entry field** and the **Short text** field type.
5. Click **Save** at the top right.

## Content Type Configuration

1. Install the app to your chosen Space.
2. Navigate to your content model and edit your chosen title field, applying your App Definition (see above) to the field's appearance.
  - Note: This repo contains an example content model (`space-export.json`) that you can import into a blank Space to get a head start.

## Server-side title propagation (App Event Subscription)

[Contentful App Events Documentation](https://www.contentful.com/developers/docs/extensibility/app-framework/app-events/)

Some fragments derive their value from data outside the entry itself:

- **`referencedEntryTitle`** — title of a referenced Region. When the Region is renamed while a parent entry is closed, the parent's title would otherwise go stale.
- **`publicationDate`** — formatted date from the Launch Release the entry is in. The editor has no signal that an entry was added to a scheduled Release, so this fragment is populated entirely server-side.

Both behaviors are handled by a **single Contentful Function** — `autoEntryTitleHandler` (declared in `contentful-app-manifest.json`, source in `functions/handler/index.ts`). A Contentful App Definition supports only **one** App Event handler function, so the function is a thin **dispatcher** that inspects the incoming `X-Contentful-Topic` header and routes to per-domain modules:

| Topic (Content Event) | Routes to | What it does |
|---|---|---|
| `ContentManagement.Entry.publish` | `functions/handler/linkedEntryTitle.ts` | Find every entry that references the published entry via `links_to_entry` and recompute their titles. This drives rename propagation for every `referencedEntryTitle` fragment (Region, Brand, etc.). |
| `ContentManagement.Release.create` / `.save` / `.archive` / `.unarchive` | `functions/handler/releaseDate.ts` | Refetch the Release, iterate its entry members, recompute each title (the `publicationDate` fragment will look up the schedule). Archive drops the date prefix; unarchive re-adds it if the ScheduledAction survived. |
| `ContentManagement.Release.delete` | `functions/handler/releaseDate.ts` | The release is gone by the time the event arrives, so we read the member list from the **event body's** `entities` array (no refetch possible). Recompute titles for those entries to drop the date prefix. |
| `ContentManagement.ScheduledAction.create` / `.save` / `.delete` | `functions/handler/releaseDate.ts` | Same as Release.save, but only when `entity.sys.linkType === "Release"`. Schedule appears, changes, or disappears. |

For each managed parent, the dispatch path: locate the title field bound to this app via the entry's editor interface → recompute via `composeTitle` (the same composition the editor uses) → idempotency-skip if the new title matches the current → otherwise update the entry as a draft.

The function is **declared** in the manifest and **bundled** by `npm run build`, but it does not run until an **App Event Subscription** is created that points the relevant topics at this function. That subscription is a one-time, per-App-Definition setup. We do this manually via the Contentful web UI rather than scripting it.

### One-time setup

Do this once, after the app has been uploaded and activated for the first time. You'll need org admin access in Contentful.

1. In the Contentful web app, switch to the organization that owns this App Definition.
2. Open **Org Settings → Apps → [the "Auto Entry Title" app definition]**.
3. Open the **Events** tab.
4. **Target**: choose **Function**, then select `autoEntryTitleHandler` as the **App event handler**. Leave the filter and transformation function slots empty.
5. **Content Events**: enable all nine:
   - `Entry.publish`
   - `Release.create`
   - `Release.save`
   - `Release.archive`
   - `Release.unarchive`
   - `Release.delete`
   - `ScheduledAction.create`
   - `ScheduledAction.save`
   - `ScheduledAction.delete`
6. Save the App Definition.

There is no content-type filter at the subscription level — every `Entry.publish` event runs through `links_to_entry`, and `recomputeTitleForEntries` only writes to entries whose title field is bound to this app (matched via the editor interface). So unrelated content types incur a single index lookup at most. `ScheduledAction.*` events are filtered down to Release-targeted actions inside the handler. Subscribing to all nine topics is correct and expected.

### Verifying the subscription

After saving:

1. In the Events tab, confirm the subscription is listed with all six topics → `autoEntryTitleHandler` as the handler.
2. **Linked-entry rename test (Region, Brand, or any other reference):** in a sandbox space, create an entry of a referenced content type (e.g., a `region` titled "EMEA"), reference it from a parent entry. Confirm the parent's title fragment shows "EMEA" (editor `subscribe` path, no function involvement). Close the parent. Rename the referenced entry to "Europe" and publish it. Reopen the parent — its title should now reflect "Europe". The same flow works for Brand references and any future `referencedEntryTitle` fragment.
3. **Release schedule test:** create a Launch Release containing a managed entry, schedule it for some date. After the function runs, the entry's title should show the date prefix (e.g. `Jul-04 - …`). Reschedule, then unschedule — the title should update to the new date, then drop the date entirely.
4. If either test fails, check the **Function logs** on the **Functions** tab for `autoEntryTitleHandler`. These logs will surface the topic that fired and any per-parent errors.

### Re-running / changing the subscription

The subscription persists at the App Definition level — redeploys of the function bundle do **not** require re-creating it. You only need to revisit this UI when:

- You change which topics the function should accept (e.g., add `Entry.unpublish` later).
- The subscription was accidentally deleted.

Editing the existing subscription in place is supported — toggle topics, change the target function, save.

### Required app permissions

For the function to read editor interfaces and update entries on parents, the App Definition must have CMA permissions sufficient for entry reads + writes. These are configured on the App Definition itself (also in the org-level App Definition settings), not in the Events tab. If the function logs `forbidden` or `unauthorized` errors, that's the place to check.

### Required at build time: `CONTENTFUL_APP_DEF_ID` (build-time inlining via esbuild)

> **Heads-up — this is the one piece of non-obvious build complexity in the repo.** If you skip this section, the function will deploy successfully but **silently update zero entries**. Read it before touching `esbuild.functions.config.js`, `functions/handler/buildtime.d.ts`, or the `build:functions` npm script.

#### What

`npm run build:functions` (which runs as part of `npm run build`) reads `CONTENTFUL_APP_DEF_ID` from the environment and uses esbuild's `define` to inline it into the function bundle as a string literal. The function code references it as the global constant `__APP_DEFINITION_ID__`. If the env var is missing at build time, the build aborts with a clear error.

This is the **same env var** already used by `npm run upload-ci`, so most CI pipelines already have it set. For local builds, set it in your shell or a `.env` file:

```
CONTENTFUL_APP_DEF_ID=<your-app-definition-id>
```

#### Why this complexity is necessary

The function needs to know its own App Definition ID at runtime to identify which entries' title fields are bound to this app. The check looks like:

```ts
editorInterface.controls.find(
  (c) => c.widgetNamespace === "app" && c.widgetId === __APP_DEFINITION_ID__,
);
```

When a content modeler configures a field to use a custom app, Contentful writes the **App Definition ID** into `editorInterface.controls[].widgetId`. Without that comparison, the function has no way to scope its writes to fields managed by this app — it would either touch every app-managed title field in the space (potentially clobbering other apps' fields) or, if we removed the check entirely, only do so by accident.

The wrinkle: **the Contentful function runtime does not provide the App Definition ID in the function context.** The context exposes `cmaClientOptions`, `spaceId`, `environmentId`, and a few other things — but no app identity. We considered three options for sourcing it:

1. **Build-time inlining via esbuild `define`** (chosen). Bundle is self-contained, no per-install configuration, no runtime cost. Cost: one small `esbuild.functions.config.js` file, and the build requires `CONTENTFUL_APP_DEF_ID` to be set.
2. **`appInstallationParameters` (runtime config screen).** More flexible for multi-customer reuse, but requires building a configuration screen in the React app where the customer types the App Definition ID at install time. Adds runtime UI surface area for a value that's effectively a constant of this build.
3. **Match by `widgetNamespace === "app"` only, no widgetId check.** Simplest possible, but risks touching unrelated apps' title fields.

For this app's customer-deployment shape (one bundle, one App Definition), option (1) is the lowest total complexity. If this app is ever distributed as a reusable, multi-install marketplace app, switching to option (2) is the right move at that point.

#### How it fits together

| File | Role |
|---|---|
| `esbuild.functions.config.js` | esbuild config that reads `process.env.CONTENTFUL_APP_DEF_ID` and `define`s it as `__APP_DEFINITION_ID__`. |
| `functions/handler/buildtime.d.ts` | One-line `declare const __APP_DEFINITION_ID__: string;` so TypeScript and editors recognize the global. |
| `functions/shared/findManagedTitleFieldId.ts` | Uses `__APP_DEFINITION_ID__` in the editor-interface match. |
| `package.json` (`build:functions` script) | Passes `--esbuild-config esbuild.functions.config.js` to `contentful-app-scripts build-functions`. |

#### Operational notes

- **If you change which App Definition the bundle is built for**, rebuild and re-upload. The id is baked in.
- **Tests** stub `globalThis.__APP_DEFINITION_ID__` in a `beforeAll` block (see `functions/handler/linkedEntryTitle.spec.ts`).

## Configuring naming behavior

Naming behavior is composed from an ordered list of fragments in `src/fragments/index.ts`. Edit the `composition` export to add, remove, or reorder fragments, then rebuild and redeploy:

```ts
export const composition: FieldNameComposition = {
  fragments: [staticString("Auto Title")],
  separator: " - ",
};
```

A fragment is any object matching the `Fragment` signature in `src/fragments/types.ts`. Its `subscribe` method receives the SDK plus an `emit(fragment)` callback, subscribes to whatever it needs, and returns a teardown that removes its listeners. `Field.tsx` joins each fragment's most-recent emitted value with the separator and writes the result to the field (skipping the write when the composed value already matches).

## Publication date fragment (Releases & Scheduled Actions)

This is the most architecturally nuanced piece of the app. If you are extending or debugging the publication-date behavior, read this section in full before changing any code in `src/fragments/publicationDate.ts` or `functions/handler/releaseDate.ts`.

### Why this fragment needs both `subscribe` and `compute`

The editor has **no SDK signal** that an entry has been added to a scheduled Launch Release. Releases are not reflected on the entry's own fields, and the schedule isn't on the Release itself (it's on a separate ScheduledAction — see below). So the editor cannot react *live* to schedule changes that happen in another tab or by another user.

But the editor still needs the date in the title:

- On entry mount, so the title doesn't get stripped of the date when the editor edits the description and triggers a recompute.
- After a deploy, when the App Event handler hasn't fired (no schedule changed) but a fresh editor session is reading the entry.

To handle this, **`publicationDate.subscribe` runs the same CMA lookup that `compute` runs.** When the editor mounts, the fragment queries `release.query` + `scheduledActions.getMany` once, finds the relevant scheduled date (if any), and emits it. Other fragments emit their values. The composed title matches the persisted title (so the equality guard in `Field.tsx` short-circuits — no write). When the editor edits another field (e.g., description), the `publicationDate` slot still has the date in memory, so the composed write keeps it.

The App Event handler runs the same lookup server-side when a Release or ScheduledAction event fires, propagating updates to closed entries. **Two paths, one lookup helper, one source of truth.**

#### Accepted staleness window

If a Release is scheduled or rescheduled in another tab/session while the editor is open, the editor's `subscribe` already fired with the old (or no) value — the in-memory slot won't update until the entry is reopened. During that window, an editor-side write (e.g., an edit to description) will produce a title without the new date. The App Event handler still fires on the schedule event and corrects the persisted title; reopening the entry shows the corrected value. This is the same staleness window every other cross-entry fragment has.

### Releases vs. Scheduled Actions: the data model

There are **two separate Contentful entities** at play, and conflating them is the most common mistake:

- A **Release** (Launch Release) is a **container** of entries/assets. It has a hard limit of 200 entities. Mutating its membership produces `Release.create` / `Release.save` / `Release.delete` events.
- A **ScheduledAction** is a **separate, independent entity** that says "publish this thing at this time." Its `entity` field is a link to either an `Entry`, `Asset`, or — critically for this app — a **`Release`**. Mutating it produces `ScheduledAction.create` / `.save` / `.delete` events.
- A "scheduled Launch Release" is therefore a Release **plus** a ScheduledAction whose `entity.sys.linkType === "Release"`. The schedule timestamp lives on the ScheduledAction's `scheduledFor.datetime` (ISO 8601), with an optional IANA `scheduledFor.timezone` (default: UTC).

**Critical implication:** rescheduling, unscheduling, and "is this Release scheduled?" all operate on the ScheduledAction, NOT on the Release entity. Calling `release.update` does not change a Release's schedule.

### State transitions and the events that signal them

| Transition | Triggering event(s) |
|---|---|
| Entry added to a Release | `Release.save` (recomputes all current members) |
| Entry removed from a Release | `Release.save` — but see "Known limitation" below |
| Release scheduled for the first time | `ScheduledAction.create` (`entity.sys.linkType === "Release"`) |
| Release rescheduled | `ScheduledAction.save` (same filter) |
| Release unscheduled (schedule canceled) | `ScheduledAction.delete` (same filter) |
| Release archived | `Release.archive` — refetch the release (still queryable after archive) and recompute; date prefix drops because archived releases aren't actively scheduled |
| Release unarchived | `Release.unarchive` — refetch and recompute; if a ScheduledAction is still attached, the date prefix is re-added |
| Release deleted | `Release.delete` — read entities from the **event body** and recompute (release is gone, can't refetch) |

### Adding more fragments like this

If you add a future fragment whose value comes from outside the entry (e.g., a CMS-external system, a tag/taxonomy lookup, etc.), follow the same pattern: a single helper that takes a CMA client + relevant ids and returns the formatted string, called from both `subscribe` (in the editor session) and `compute` (in the App Event handler). Make sure the editor's `subscribe` returns a teardown that cancels any in-flight async work — `publicationDate` does this with a `cancelled` flag — so a fast unmount/remount doesn't emit stale data into a torn-down slot.

### Setup

Subscription wiring is documented above in **"Server-side title propagation (App Event Subscription)"** — a single subscription on `autoEntryTitleHandler` covers both linked-entry rename propagation and Release lifecycle events. The eight Release/ScheduledAction topics in this section are part of that single subscription's topic list.

### Date format and timezone

The fragment is `Mon-DD` (3-character month abbreviation, 2-digit day, hyphen-separated, no year — e.g. `Jul-04`, `Dec-29`). The calendar date is computed in the ScheduledAction's `scheduledFor.timezone` if present, otherwise in UTC.

This is documented because timezone semantics for "what calendar date is this scheduled for" are not obvious. A release scheduled for `2026-07-04T03:00:00Z` with `scheduledFor.timezone === "America/Los_Angeles"` shows up as `Jul-03`, not `Jul-04`, because at 3 AM UTC on July 4 it is still 8 PM **July 3** in LA.

### Recursion safety

The function will not loop on Release schedule events:

- The dispatcher only routes `Release.*` and `ScheduledAction.*` topics into the schedule handler. Entry updates via `cma.entry.update` produce `Entry.save`, not `Release.save` or `ScheduledAction.*`, so writes from the schedule handler do not feed back into it.
- Title rewrites on managed parents produce `Entry.save`, not `Entry.publish`, so they don't re-enter the linked-entry rename path. Even if they did publish, `recomputeTitleForEntries` would skip them when the new title matches the current.
- The idempotency guard (skip the CMA write when the new title matches the current) prevents redundant writes even if the same event re-fires.

### Shared utilities

The dispatcher and its per-domain modules use:

- `functions/shared/findManagedTitleFieldId.ts` — locates the title field on a parent entry's editor interface that is bound to this app, returning `null` for unmanaged content types. Also exports `resolveDefaultLocale`.
- `functions/shared/recomputeTitleForEntries.ts` — the per-parent loop: locate the managed title field, recompute via `composeTitle`, idempotency-skip, write as a draft. Both `linkedEntryTitle.ts` and `releaseDate.ts` end with a call to this helper.
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

## Future improvements

### Eliminate the mount-time title flicker

**Observed:** when opening an entry in the editor, the title field briefly shows intermediate values before settling on the correct final value (e.g., the description appears immediately, then the date prefix appears ~200ms later, then the region appears ~100ms after that).

**Cause:** `Field.tsx` calls `recompute()` after every `emit()`. On mount, synchronous fragments (`staticString`, `contentType`, `fieldValue`) emit immediately, while async fragments (`publicationDate`, `referencedEntryTitle`) emit after their CMA lookups resolve. Each emit triggers a recompute, and each recompute writes a different intermediate string to the field.

**Proposed fix:** defer the first `recompute()` until every fragment has emitted at least once. After that, behave as today.

Sketch:

```ts
const seen = new Set<number>();
const total = composition.fragments.length;

const recompute = () => {
  if (seen.size < total) return; // wait for all initial emits
  const next = joinFragments(fragments, separator);
  if (next !== sdk.field.getValue()) sdk.field.setValue(next);
};

const teardowns = composition.fragments.map((fragment, index) =>
  fragment.subscribe({
    sdk,
    emit: (value) => {
      fragments[index] = value;
      seen.add(index);
      recompute();
    },
  }),
);
```

**Expected outcome:** on mount, zero intermediate writes; usually zero writes total, because the assembled value matches the persisted value (which the server-side function already wrote). Post-mount reactivity (description edits, region picks) is unchanged — every fragment has already emitted, so each subsequent emit triggers an immediate recompute and write.

**Why not removing `subscribe` entirely:** the editor needs `subscribe` to emit the current value on mount so `recompute()` doesn't strip live values out of the persisted title. Without subscribe, the editor would actively erase the date and region on every entry open.
