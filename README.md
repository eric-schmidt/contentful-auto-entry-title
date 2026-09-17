# Auto Entry Title

## Overview

The main goal of this app is to automatically generate the value of an entry's title field by composing an ordered list of fragments — small modules that each contribute one piece of the final string (e.g., a value pulled from another field, a Launch Release scheduled date, a fixed prefix). Fragments are concatenated with a configurable separator and written to the field on which the app is mounted.

This app is intended for non-localized entry-title fields. The composed value is written via `sdk.field.setValue`, which targets the locale of the mounted field.

## Local Setup

1. Clone down this repo.
2. Ensure you are using a minimum of Node v22 (if using [NVM](https://github.com/nvm-sh/nvm) you can just run `nvm use` in the repo root).
3. Run `npm install` to install dependencies.
4. Copy `.env.example` to `.env` and fill in the values:
   - `CONTENTFUL_ORG_ID`, `CONTENTFUL_APP_DEF_ID` — identify the App Definition. `CONTENTFUL_APP_DEF_ID` is **required at build time** (see "Required at build time" below).
   - `CONTENTFUL_ACCESS_TOKEN` — a personal access token, used by `npm run upload`, `npm run upload-ci`, `npm run upsert-actions`, and `npm run import-content-model`. **The name is not ours to choose, so don't "clean it up" to `CONTENTFUL_MANAGEMENT_TOKEN`.** `@contentful/app-scripts` hardcodes it (`ACCESS_TOKEN_ENV_KEY = 'CONTENTFUL_ACCESS_TOKEN'` in its `constants.js`) with no flag to override, and the *interactive* `npm run upload` reads it directly from the environment — rename it and every upload prompts for a browser OAuth paste instead. The CLI also **writes this name back into `.env`** after such a prompt, so a rename gets silently re-added alongside it.
   - `CONTENTFUL_DELIVERY_KEY` — a read-only Delivery API key. Used for **taxonomy concept reads at function runtime** (see "Taxonomy notation fragment"). **It must be authorized for every environment the app is installed in, not just `master`** — a Delivery key is scoped per environment, and a key that lacks the app's environment makes every concept read return `404`, which looks exactly like a missing API route. This is the single most likely reason the notation blob silently goes missing from titles.
5. Run `npm run build` to create the build directory that can be uploaded to Contentful.
6. You can run the *frontend* portion of this app locally using `npm run start`; however, the backend Functions have to be uploaded to Contentful in order to work properly (see next section).

## App Definition Setup
1. Navigate to your Contentful Organization overview and click on **Apps**.
2. Click **Create app** on the top right.
3. Add a **Title** and set the hosing URL to http://localhost:3000 for now (just so you can save the definition).
4. Under **Locations**, select **Entry field** and the **Short text** field type.
5. Click **Save** at the top right.

## Uploading a bundle to Contentful
1. Once the App Definition has been created above, in the root directory for this repo, copy `.env.example` to `.env` and fill in the values. You can get the App Definition ID from the config screen above.
2. Run `npm run build && npm run upload`, which will build the bundle and upload to Contentful in one simple step.

## Importing a Space Export

1. Drop one or more `contentful space export` JSON dumps in `exports/space/`. This repo ships with `exports/space/export.json` as a ready-to-use example content model.
2. Make sure the target space is blank — `contentful-import` is idempotent by entity `sys.id`, so re-running against a populated space *updates* matching entities in place rather than failing.
3. Run `npm run import-content-model`. The script lists every `.json` in `exports/space/` and (if there's more than one) asks which to use; then prompts for space ID, environment ID, and a y/N confirm. Pass `--yes` to skip the confirm in scripted environments.
4. The chosen export is sent through `contentful-import` in full — content types, editor interfaces, locales, tags, entries, and assets (with binaries). CMA errors are surfaced verbatim, including a `details:` block with the underlying response.

The token is read from `CONTENTFUL_ACCESS_TOKEN` in `.env` at the repo root (the same token `npm run upload-ci` uses). Space and environment IDs are prompted for each run rather than read from `.env` — they change per environment.

## Content Type Configuration

1. Install the app to your chosen Space.
2. Navigate to your content model and edit your chosen title field, applying your App Definition (see above) to the field's appearance.
  - Note: This repo contains an example content model (`exports/space/export.json`) that you can import into a blank Space to get a head start (see "Importing a Space Export" above).

## Configuration for server-side propagation (App Events)

[Contentful App Events Documentation](https://www.contentful.com/developers/docs/extensibility/app-framework/app-events/)

Some fragments derive their value from data outside the entry itself:

- **`referencedEntryTitle`** — title of a referenced Region. When the Region is renamed while a parent entry is closed, the parent's title would otherwise go stale.
- **`publicationDate`** — formatted date from the Launch Release the entry is in. The editor has no signal that an entry was added to a scheduled Release, so this fragment is populated entirely server-side.

Both behaviors are handled by a **single Contentful Function** — `autoEntryTitleHandler` (declared in `contentful-app-manifest.json`, source in `functions/handler/index.ts`). A Contentful App Definition supports only **one** App Event handler function, so the function is a thin **dispatcher** that inspects the incoming `X-Contentful-Topic` header and routes to per-domain modules:

> That cap applies to `appevent.handler` **only**. `appaction.call` functions are unrestricted, which is why the concept-repair action (`functions/handler/actions.ts`) is a second, separate function rather than another branch of this dispatcher — see "Propagating concept edits".

| Topic (Content Event) | Routes to | What it does |
|---|---|---|
| `ContentManagement.Entry.publish` | `functions/handler/linkedEntryTitle.ts` | Recompute the **published entry's own** title, then find every entry that references it via `links_to_entry` and recompute those too. The second half drives rename propagation for every `referencedEntryTitle` fragment (Region, Brand, etc.); the first covers a publish made from the Taxonomy tab, where the editor widget isn't mounted. Both are draft writes. |
| `ContentManagement.Release.create` / `.save` / `.archive` / `.unarchive` | `functions/handler/releaseDate.ts` | Refetch the Release, iterate its entry members, recompute each title (the `publicationDate` fragment will look up the schedule). Archive drops the date prefix; unarchive re-adds it if the ScheduledAction survived. |
| `ContentManagement.Release.delete` | `functions/handler/releaseDate.ts` | The release is gone by the time the event arrives, so we read the member list from the **event body's** `entities` array (no refetch possible). Recompute titles for those entries to drop the date prefix. |
| `ContentManagement.ScheduledAction.create` / `.save` / `.delete` | `functions/handler/releaseDate.ts` | Same as Release.save, but only when `entity.sys.linkType === "Release"`. Schedule appears, changes, or disappears. |

For each managed entry, the dispatch path: locate the title field bound to this app via the entry's editor interface → recompute via `composeTitle` (the same composition the editor uses) → idempotency-skip if the new title matches the current → otherwise `cma.entry.patch` the entry, which writes the **draft** only.

Two consequences of that last step, both deliberate. Patching a published entry leaves it in **"Changed"** state, so a human has to publish again to make the corrected title live — the function never publishes. And because a draft write emits `Entry.save`, which this dispatcher does not route, nothing the function writes can feed back into it (see "Recursion safety").

The function is **declared** in the manifest and **bundled** by `npm run build`, but it does not run until an **App Event Subscription** is created that points the relevant topics at this function. That subscription is a one-time, per-App-Definition setup. We do this manually via the Contentful web UI rather than scripting it.

### One-time setup

Do this once, after the app has been uploaded and activated for the first time. You'll need org admin access in Contentful.

1. In the Contentful web app, switch to the organization that owns this App Definition.
2. Open **Org Settings → Apps → [the "Auto Entry Title" app definition]**.
3. Open the **Events** tab.
4. **Target**: choose **Function**, then select `autoEntryTitleHandler` as the **App event handler**. Leave the filter and transformation function slots empty.
5. **Content Events**: enable all of the following:
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

Then, for the taxonomy notation fragment and its repair action:

7. **Authorize the Delivery key for the app's environment** — Space → **Settings → API keys** → the key used for `CONTENTFUL_DELIVERY_KEY` → add every environment the app is installed in. Taxonomy is org-level, so the concepts are identical in every environment; this step is purely about *key authorization*. Skipping it makes concept reads 404 and drops the notation from every title the function rewrites.
8. **Put the key in `.env` as `CONTENTFUL_DELIVERY_KEY`, then build and upload.** `esbuild.functions.config.js` inlines it into both function bundles as `__DELIVERY_KEY__`; `npm run build` followed by `npm run upload` is what actually delivers it to the deployed function. There is no installation parameter and no console step.

   This is a build-time inline because a **deployed Contentful Function has no environment-variable mechanism** — `.env` is a local build artifact and never reaches the function runtime. The two available channels are this inline and a Secret installation parameter; the inline was chosen so `.env` is the single place the key is configured. Two consequences are real and worth knowing:

   - The key is embedded in the bundle uploaded to Contentful. `build/` is gitignored so it stays out of version control, but **treat built artifacts as containing a credential**.
   - **Rotating the key requires a rebuild and re-upload.** Changing it in Contentful alone will not update the deployed function.

   The key is read-only and space-scoped, which bounds the exposure. A build with no key set still succeeds — it warns, and the deployed function degrades to titles without notations.
9. **Create the App Action** — run `npm run upsert-actions` (interactive) or `npm run upsert-actions-ci`. This registers `recomputeConceptTitles` against the App Definition from the `actions[]` block in the manifest. See "Propagating concept edits".

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

**Taxonomy reads are the exception: they do not go through app identity at all.** There is no space-scoped CMA taxonomy route — it returns `404` — so `context.cma` cannot read concepts no matter what permissions the App Definition is granted. Concept reads inside the function use the Delivery API with `CONTENTFUL_DELIVERY_KEY` instead. Granting the app more CMA permissions will never fix a failing concept read; check the key's environment authorization instead.

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
| `esbuild.functions.config.js` | esbuild config that reads `process.env.CONTENTFUL_APP_DEF_ID` and `define`s it as `__APP_DEFINITION_ID__`, plus `CONTENTFUL_DELIVERY_KEY` as `__DELIVERY_KEY__`. |
| `functions/handler/buildtime.d.ts` | `declare const` for both globals, so TypeScript and editors recognize them. |
| `functions/shared/findManagedTitleFieldId.ts` | Uses `__APP_DEFINITION_ID__` in the editor-interface match. |
| `package.json` (`build:functions` script) | Passes `--esbuild-config esbuild.functions.config.js` to `contentful-app-scripts build-functions`. |

#### Operational notes

- **If you change which App Definition the bundle is built for**, rebuild and re-upload. The id is baked in.
- **Tests** stub `globalThis.__APP_DEFINITION_ID__` in a `beforeAll` block (see `functions/handler/linkedEntryTitle.spec.ts`).
- **`CONTENTFUL_DELIVERY_KEY` is inlined the same way**, as `__DELIVERY_KEY__`, because a deployed Function has no env-var mechanism to read it from. Unlike the app definition id, a missing delivery key does **not** fail the build — it warns, and the function degrades to titles without notations. The tradeoff and its two consequences (a credential inside the uploaded bundle; rotation needs a rebuild + re-upload) are spelled out in "One-time setup", step 8.
- The org id is **not** inlined — the editor reads it from `sdk.ids.organization`, which the SDK already provides. Don't add a define for it.
- Both function entry points (`functions/handler/index.ts` and `functions/handler/actions.ts`) are built from this one config and both receive the define.

## Configuring naming behavior

Naming behavior is composed from an ordered list of fragments in `src/fragments/index.ts`. Edit the `composition` export to add, remove, or reorder fragments, then rebuild and redeploy:

```ts
export const composition: FieldNameComposition = {
  fragments: [staticString("Auto Title")],
  separator: " - ",
};
```

A fragment is any object matching the `Fragment` signature in `src/fragments/types.ts`. Its `subscribe` method receives the SDK plus an `emit(fragment)` callback, subscribes to whatever it needs, and returns a teardown that removes its listeners. `Field.tsx` joins each fragment's most-recent emitted value with the separator and writes the result to the field (skipping the write when the composed value already matches).

The composition also hardcodes the ids it reads: field ids `description` and `regions`, and taxonomy scheme ids `division` and `brand`. There is no per-content-type configuration UI — `src/fragments/index.ts` is the one place to change them.

### `conceptNotation({ schemeIds })`

Emits the concatenated **notations** of the taxonomy concepts assigned to the entry — e.g. an entry tagged `Men's` (notation `M`) and `Double RL` (notation `RRL`) contributes `MRRL`.

- **`schemeIds` is both the filter and the output order.** Only concepts belonging to a listed scheme contribute, and schemes emit in the order given. So the output is independent of the order concepts happen to appear in `metadata.concepts`, and `["division", "brand"]` always yields `M` before `RRL`.
- **Season and Year are deliberately excluded.** The content model tags all four schemes, but only Division and Brand belong in the title. Adding them is a one-line change to `schemeIds`.
- **The intra-fragment join is `""`, not the composition separator.** All notations concatenate into a *single* emitted string, so `joinFragments` sees one slot and the `" - "` separator never lands mid-blob — you get `… - MRRL - …`, never `M - RRL`.
- A concept whose notation is empty, or which belongs to no listed scheme, contributes nothing.

See "Taxonomy notation fragment" below for how the concepts are actually read, which is the non-obvious part.

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

The other worked example is `conceptNotation` (see "Taxonomy notation fragment"). It is the only fragment that reads `metadata` rather than `fields`, and the only one that needs a capability the shared `FragmentCmaClient` cannot provide — so it is the pattern to copy if your fragment's data lives off the entry's fields or off the space-scoped CMA.

If you add a future fragment whose value comes from outside the entry (e.g., a CMS-external system, a tag/taxonomy lookup, etc.), follow the same pattern: a single helper that takes a CMA client + relevant ids and returns the formatted string, called from both `subscribe` (in the editor session) and `compute` (in the App Event handler). Make sure the editor's `subscribe` returns a teardown that cancels any in-flight async work — `publicationDate` does this with a `cancelled` flag — so a fast unmount/remount doesn't emit stale data into a torn-down slot.

### Setup

Subscription wiring is documented above in **"Server-side title propagation (App Event Subscription)"** — a single subscription on `autoEntryTitleHandler` covers both linked-entry rename propagation and Release lifecycle events. The Release/ScheduledAction topics in this section are part of that single subscription's topic list.

### Date format and timezone

The fragment is `Mon-DD` (3-character month abbreviation, 2-digit day, hyphen-separated, no year — e.g. `Jul-04`, `Dec-29`). The calendar date is computed in the ScheduledAction's `scheduledFor.timezone` if present, otherwise in UTC.

This is documented because timezone semantics for "what calendar date is this scheduled for" are not obvious. A release scheduled for `2026-07-04T03:00:00Z` with `scheduledFor.timezone === "America/Los_Angeles"` shows up as `Jul-03`, not `Jul-04`, because at 3 AM UTC on July 4 it is still 8 PM **July 3** in LA.

### Recursion safety

The function will not loop on Release schedule events:

- The dispatcher only routes `Release.*` and `ScheduledAction.*` topics into the schedule handler. Entry writes via `cma.entry.patch` produce `Entry.save`, not `Release.save` or `ScheduledAction.*`, so writes from the schedule handler do not feed back into it.
- Title rewrites produce `Entry.save`, not `Entry.publish`, so they don't re-enter the linked-entry rename path. Even if they did publish, `recomputeTitleForEntries` would skip them when the new title matches the current.
- This holds for the **published entry itself**, which the `Entry.publish` path now includes in its recompute set. That entry's correction is the same draft `cma.entry.patch` as any other, so it emits `Entry.save` and the argument above is unchanged. The invariant to preserve: `cma.entry.patch` is the only CMA mutation in the repo, and there are **zero** `.publish()` calls. Adding one here — to clear the "Changed" badge automatically — would make the handler re-enter itself, and the guard would then be behavioural (the idempotency check) rather than structural. It was considered and rejected for exactly that reason.
- The idempotency guard (skip the CMA write when the new title matches the current) prevents redundant writes even if the same event re-fires.

### Shared utilities

The dispatcher and its per-domain modules use:

- `functions/shared/findManagedTitleFieldId.ts` — locates the title field on a parent entry's editor interface that is bound to this app, returning `null` for unmanaged content types. Also exports `resolveDefaultLocale`.
- `functions/shared/recomputeTitleForEntries.ts` — the per-entry loop: locate the managed title field, recompute via `composeTitle`, idempotency-skip, `cma.entry.patch` the draft. `linkedEntryTitle.ts`, `releaseDate.ts` and `actions.ts` all end with a call to this helper. Entries handed to it must be **CMA-fetched**, never App Event body snapshots — see the header comment in `linkedEntryTitle.ts` for the data-loss reason.
- `src/fragments/compose.ts` — `composeTitle` is the single source of truth for "what should this entry's title be right now."

If you add a new dispatch route, follow the same shape: identify the affected entries, then call `recomputeTitleForEntries` with the list. Don't reimplement the per-parent loop or skip the idempotency guard — they're part of the contract.

## Taxonomy notation fragment

The counterpart to the publication-date section: `conceptNotation` is the second fragment whose value lives entirely outside the entry's own fields. Read this before changing `src/fragments/concepts.ts`, `src/fragments/conceptReaderBrowser.ts`, or `functions/shared/conceptReaderForFunction.ts`.

What it produces is described under **"Configuring naming behavior"** above. This section is about *how it reads concepts*, which is where all the complexity is.

### Why concepts can't be observed like a field

Taxonomy concepts are **not fields**. They live on the entry's `metadata.concepts` as a flat, mixed-scheme array of `Link<'TaxonomyConcept'>` — e.g. `[2026, mens, rlx, spring]`, with no grouping by scheme. Two consequences:

- `sdk.entry.fields[id].onValueChanged(...)` — the mechanism every other fragment uses — **cannot see them**. `conceptNotation.subscribe` instead pairs `sdk.entry.getMetadata()` for the initial paint with `sdk.entry.onMetadataChanged(cb)` for live updates. Both are on `EntryAPI`.
- The scheme a concept belongs to is not on the link. It has to come from the concept read itself.

`onMetadataChanged` may fire synchronously on subscribe. That's harmless: `Field.tsx` skips the write when the composed title is unchanged.

#### Expected: the title updates when you switch back to the Editor tab

Concepts are assigned on the entry editor's **Taxonomy** tab. This app renders on the **Editor** tab, and the web app unmounts the inactive tab's DOM — so while you're on Taxonomy, **this app is not running**. Adding or removing a concept therefore does not move the title at that moment; the title updates when you navigate back to the Editor tab.

That is the expected behaviour, and it is not a bug in this app:

- Our iframe is destroyed on tab switch, so no `metadataChanged` message can be delivered to it, and no polling or alternative subscription (`onSysChanged`, a timer, a sidebar location) can change that — none of them run either.
- On return, `onMetadataChanged` is a `MemoizedSignal`: it replays the current metadata to the listener the instant we resubscribe, which is precisely why switching back applies the change immediately.

The persisted title is still correct in every case — the update lands as soon as the tab is active, and the server-side path is authoritative regardless. The one thing to know is the ordering consequence below.

> **If you publish straight from the Taxonomy tab**, the entry goes live with a title that hasn't been recomputed yet — the widget wasn't mounted to recompute it. The `Entry.publish` handler then recomputes the published entry's own title and corrects it, but as a **draft write**: within a few seconds the entry shows as **"Changed"** with the right title in the draft, and **a human has to publish again** to make it live. The function deliberately does not republish (see "Recursion safety").
>
> So this is a safety net, not a fix. Switching back to the Editor tab before publishing still gets it right the first time, as does the App Action in "Propagating concept edits".
>
> Two cases where even the draft isn't corrected, both of which log a warning in the function logs rather than writing a wrong title:
>
> - **The taxonomy read failed** (missing or unauthorized delivery key). `conceptNotation.compute` returns `null`, which poisons the whole join, and every write path skips — so the stored title is left exactly as it was. Symptom: titles that don't update at all, never titles missing their notation.
> - **The entry fetch failed.** The handler warns `failed to fetch the published entry "<id>"` and continues with the fan-out; only that one entry's own title goes uncorrected.

### Why the read is per-scheme, not per-concept

Neither transport offers a concept-**id** filter. The management SDK's `GetManyConceptParams` accepts `{ pageUrl }` XOR `{ conceptScheme, query }`; the CDA likewise exposes `conceptScheme` and nothing id-shaped. So the read is inverted: fetch **each scheme once**, build a scheme→concepts map, then walk `metadata.concepts` against it.

That is cheap here — Division and Brand hold 7 concepts total — and it means the scheme is known from the *query* rather than from the response. Which matters, because of a real typing trap: `ConceptProps` is declared as `Omit<Concept, 'conceptSchemes'>` over a base that never declared `conceptSchemes`, so the typed shape is missing a field the wire response actually returns. Knowing the scheme from the query sidesteps that entirely.

Both transports follow cursor pagination via `pages.next` (there is **no `total`** and no `skip` on this collection) up to a page cap, so growing a scheme past one page doesn't silently truncate.

### Where taxonomy actually lives: the scoping table

This is the part that costs an afternoon to rediscover:

| Route | Result |
|---|---|
| **CDA** `GET /spaces/{s}/environments/{e}/taxonomy/concepts?conceptScheme={id}` | ✅ **200** — returns `notations` and `conceptSchemes` verbatim |
| CDA `/concepts`, `/taxonomy/concept_schemes`, `/concept_schemes` | ❌ 404 on both `cdn` and `preview` hosts |
| **Space-scoped CMA** taxonomy | ❌ **404 — the route does not exist** |
| **Org-scoped CMA** `concept.getMany` | ✅ works |
| GraphQL CDA | ❌ no concept/taxonomy root field |
| An entry's own CDA response | ❌ does not inline concept notations; `includes` has no concept entries |

Taxonomy is **org-level**: the concepts are byte-identical across every environment in the org. So a 404 from the CDA taxonomy route is almost never a missing route or a missing concept — it's the Delivery key not being authorized for that environment.

### Two transports, one pure function

`ConceptReader` is the seam — `(schemeId) => Promise<ConceptRecord[]>`. Both phases of the fragment funnel into the same pure `notationForSchemes(...)`, so the two-phase contract **cannot drift by accident**; a parity test in `conceptNotation.spec.ts` pins `subscribe`'s last emit to `compute`'s return across a table of concept sets.

| | Editor (`subscribe`) | Function (`compute`) |
|---|---|---|
| Transport | plain `fetch` against `cdn.contentful.com` | plain `fetch` against `cdn.contentful.com` |
| Scope | space + environment | space + environment |
| Credential | `CONTENTFUL_DELIVERY_KEY`, inlined into the browser bundle via `envPrefix` | `CONTENTFUL_DELIVERY_KEY`, inlined at build time as `__DELIVERY_KEY__` |
| Caching | memoized per scheme, module scope, never invalidated for the session | **uncached** |
| Built by | `src/fragments/conceptReaderBrowser.ts` | `functions/shared/conceptReaderForFunction.ts` |

Both phases run the **same** `createCdaConceptReader` from `src/fragments/concepts.ts`; only the key's delivery route differs. Three things about this are load-bearing:

- **`sdk.cmaAdapter` cannot read concepts, and never will.** The App SDK's CMA proxy enforces a hardcoded entity allowlist — `CMAClient` in `@contentful/app-sdk/dist/types/cmaClient.types.d.ts` enumerates ~40 entity types and `concept` is **not** among them. Calling it anyway fails at runtime with `You can not access the entity type Concept from within an app.` That is the proxy refusing to route, not a permissions problem: `cmaAdapter` is scoped to `/spaces/{id}/environments/{id}` and taxonomy is **org-level**, so no permission grant, key, or TypeScript cast can reach concepts through it. An earlier version of this app tried exactly that (`conceptReaderSdk.ts`, now deleted) — don't try it again.
- **A read-only Delivery key ships in the browser bundle.** This is the accepted cost of the above, and it's the ordinary way CDA keys are used in browser apps: it grants published-read on this one space and nothing more. `vite.config.mts` widens `envPrefix` to list `CONTENTFUL_DELIVERY_KEY` **by exact full name** so `.env` stays the single source. **Never widen that to a bare `CONTENTFUL_` prefix** — it would sweep in `CONTENTFUL_ACCESS_TOKEN`, a management PAT, and publish it to every visitor. (`npm run build` then grep the bundle in `build/assets/` to confirm only the delivery key is present.)
- **App Actions were the alternative, and were rejected.** They are asynchronous-by-design with no synchronous response — you poll `createWithResult` — which would delay the title paint by seconds on every entry open.

The CDA taxonomy endpoint is browser-callable: `access-control-allow-origin: *` with `authorization` among the allowed request headers, verified against `cdn.contentful.com`. No proxy or CORS workaround is needed.

The function reader is deliberately **uncached**: function instances are reused across invocations, and a cache there would defeat the entire point of the repair action — you'd recompute titles from the stale notations you were trying to fix.

### Editor-side staleness

`withConceptCache` memoizes by scheme, in-flight promises included, and is **never invalidated for the session**. If a notation is edited in another tab, the editor shows the old value until the entry is reopened. That is the same accepted staleness window every cross-entry fragment has, and the server-side path is authoritative. Don't add refresh logic to "fix" it.

### Failure behaviour

A reader that rejects, or a context with no `conceptReader` at all, produces `console.warn("[auto-entry-title] conceptNotation: …")` and — importantly — **`null`, not an empty string**. The fragment **never throws from `subscribe`**.

That distinction is the difference between a degraded title and data loss. `""` means "this entry has no notation"; `null` means "I could not find out". Since a title composed without the notation looks perfectly valid, and both write paths persist whatever they compose (the editor autosaves, the Function PATCHes), treating a failed read as `""` would **delete** the `MRRL` blob from entries whose titles were already correct — on every entry open, across a whole publish fan-out. So `null` poisons the join (`joinFragments` returns `null`) and every writer skips the write, leaving the stored title exactly as it was. The warning in the log is the only visible symptom, which is what to grep for when titles stop updating.

Two consequences worth knowing:

- **A missing delivery key now means "titles stop being maintained", not "titles lose their notation".** That is the safer failure, but it is quieter — check the function logs and the browser console for the warning.
- `conceptReader` is an *optional* context key, so a code path that forgets to thread it through still compiles. It no longer corrupts data, but it does silently stop maintaining titles, which is why the dispatcher forwards it on **both** branches and why `functions/handler/index.spec.ts` asserts it. Note that `npm run build` does not typecheck (`vite build` and vitest both only transpile); run `npx tsc --noEmit` if you want the compiler's opinion.

### Propagating concept edits

Renaming a referenced *entry* propagates via `ContentManagement.Entry.publish` + `links_to_entry`. Editing a *concept's notation* has the reverse index but **no event**:

- ✅ The reverse lookup exists: `entries?metadata.concepts.sys.id[in]={ids}` is the concept analogue of `links_to_entry`.
- ❌ **No App Event topic fires on a taxonomy change.** Not in the valid-topics list at all. There is nothing to subscribe to, which is why `functions/handler/index.ts` has no concept branch.

So propagation rides an **App Action** instead — `functions/handler/actions.ts`, `accepts: ["appaction.call"]`, invoked manually. It takes a comma-separated `conceptIds` parameter (App Action parameters are limited to `Symbol | Enum | Number | Boolean`, so there is no array type), pages the reverse lookup at 100, and delegates to the **existing** `recomputeTitleForEntries` — the same per-parent loop, idempotency guard, and draft write-back the event handlers use.

> A Contentful App Definition supports only **one** `appevent.handler` function — which is why `index.ts` is a topic dispatcher. That cap does **not** apply to `appaction.call`, so the action is legitimately its own entry point and its own bundle. Don't fold it into the dispatcher.

Recursion safety is inherited: the action patches entries as **drafts**, so it emits `Entry.save`, never `Entry.publish`, and cannot feed back into the rename path. Re-running it is free — the `newTitle === currentTitle` check skips every unchanged entry.

**To invoke it:** create an App Action call against `recomputeConceptTitles` with `{"conceptIds": "mens,doubleRl"}` — via the CMA, the CLI, or `curl`. Register the action first with `npm run upsert-actions`.

If no delivery key was inlined at build time, the action **bails without writing anything** and warns. That is deliberate: recomputing every title with no concept reader would strip the notation from all of them, which is strictly worse than leaving stale titles in place.

#### Known limitations

State these plainly rather than papering over them:

- **An unattended taxonomy edit propagates to nothing** until someone invokes the action, or each affected entry is next opened (whose `subscribe` re-reads live concepts, and the web app autosaves) or next published.
- **Nothing invokes the action at all** — not automatically, and not from the UI. This app registers only the `entry-field` location, so there is no rendered surface with a button on it; callers today are the CMA, the CLI, or `curl`. Giving it a page location with a concept picker, and moving its writes onto the Bulk Entry Content Operations API so a large repair doesn't hit the ~7 req/s CMA limit, is a **planned but deferred** item — see `TODO.md`. If *unattended* propagation ever becomes a hard requirement, the only real options are an external scheduled poller diffing `sys.updatedAt` on concepts, or Contentful shipping a taxonomy event topic — both out of scope.
- **Concept deletion** removes the link from `metadata.concepts`, which is an *entry* change rather than a concept event — same gap, same repair paths.
- **The CDA reads published taxonomy state.** A concept edit not yet visible to the CDA won't appear. The org-scoped CMA is the read-your-writes path if that ever matters.
- **Season and Year are excluded by choice**, not by limitation — add them to `schemeIds`.

## Mount-time writes are withheld

**The problem this solves.** `Field.tsx` recomputes after every `emit()`. Synchronous fragments (`contentType`, `fieldValue`) emit immediately; async ones (`publicationDate`, `conceptNotation`, `referencedEntryTitle`) emit only once their lookups resolve. Writing on each emit produced visible flicker — description, then date, then region — and, worse, each intermediate write was a real autosave of a title missing its later pieces.

**How it works now.** Every slot starts as `null` ("unknown"), not `""`. `joinFragments` returns `null` if *any* slot is still unknown, and `recompute` returns early on `null` without touching the field. So the first write happens only once every fragment has reported, and it usually writes nothing at all, because the assembled value already matches what the server-side function persisted.

The same mechanism doubles as the data-loss guard: a fragment that reports `null` because a lookup *failed* (not merely pending) also withholds the write, so a failed taxonomy read leaves the stored title alone instead of autosaving a notation-stripped version of it. See "Failure behaviour" under the taxonomy fragment.

**What this asks of fragment authors:** every `subscribe` path must emit something, guard clauses included. A slot that never emits withholds the title forever. A permanent "there is nothing here" condition — a field id absent from this content type, say — is `""`, not silence; only a genuine unknown is `null`. `fieldValue.ts` and `referencedEntryTitle.ts` show the missing-field branches doing this.

**Why `subscribe` can't just be removed:** the editor needs it to report each fragment's current value on mount. Without it, the first recompute would assemble a title from nothing and erase the date, notation, and region on every entry open.

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

#### `npm run upsert-actions`

Registers the App Actions declared in the `actions[]` block of `contentful-app-manifest.json` against the App Definition — currently just `recomputeConceptTitles` (see "Propagating concept edits"). Interactive: prompts for org, definition, and token. `npm run upsert-actions-ci` reads the same `CONTENTFUL_ORG_ID` / `CONTENTFUL_APP_DEF_ID` / `CONTENTFUL_ACCESS_TOKEN` trio as `upload-ci`.

Run it once at setup, and again whenever an action's name, description, or parameters change in the manifest.

> **Note:** this command **rewrites `contentful-app-manifest.json` in place**, stamping the remote action id back into each entry and reformatting the file with 2-space JSON. That is `@contentful/app-scripts` behaviour, not ours. Expect a diff on the manifest after running it, and commit it — the stamped id is what makes subsequent runs an update rather than a duplicate create.

#### `npm run import-content-model`

Picks a `.json` export from `exports/space/` (auto-selects if only one, prompts otherwise) and imports it in full — content types, editor interfaces, locales, tags, entries, assets — via `contentful-import`. Prompts for space ID, environment ID, and a y/N confirm (`--yes` skips); reads `CONTENTFUL_ACCESS_TOKEN` from `.env`. Idempotent by `sys.id` — existing entities are updated, not failed. CMA errors surface with a `details:` block.

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
