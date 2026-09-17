# Auto Entry Title

## Overview

This app automatically generates the value of an entry's title field by composing
an ordered list of **fragments** — small modules that each contribute one piece
of the final string (a value pulled from another field, a Launch Release
scheduled date, a taxonomy notation, a fixed prefix). Fragments are concatenated
with a configurable separator and written to the field the app is mounted on.

It is intended for **non-localized** entry-title fields: the composed value is
written via `sdk.field.setValue`, which targets the locale of the mounted field.

Titles are also maintained **server-side** by a Contentful Function, so a rename
or a schedule change propagates to entries nobody has open.

## Quickstart

The minimum path from a clone to a working install. Each step links to its
details below.

1. `nvm use && npm install` — Node v22 minimum ([details](#local-setup)).
2. **Create the App Definition** in your org: Apps → Create app → Locations →
   **Entry field** + **Short text** ([details](#app-definition-setup)).
3. `cp .env.example .env` and fill in `CONTENTFUL_ORG_ID`,
   `CONTENTFUL_APP_DEF_ID`, `CONTENTFUL_ACCESS_TOKEN`, `CONTENTFUL_DELIVERY_KEY`
   ([details](#environment-variables)).
4. `npm run build && npm run upload` — builds the app plus both function bundles
   and uploads them ([details](#uploading-a-bundle-to-contentful)).
5. **Wire the App Event Subscription**: org App Definition → **Events** → target
   the Function `autoEntryTitleHandler`, enable all **nine** topics
   ([details](#one-time-setup)).
6. **Grant CMA entry read + write** on the App Definition
   ([details](#required-app-permissions)).
7. `npm run upsert-actions` — registers the `recomputeConceptTitles` App Action.
8. **Authorize the Delivery key for every environment** the app is installed in
   (Space → Settings → API keys).
9. **Install the app to the space** and set it as the title field's appearance
   ([details](#content-type-configuration)).

Two steps are the ones people miss, and both fail quietly:

> **Step 5 is manual and the app does nothing without it.** The function is
> declared in the manifest and bundled by `npm run build`, but it does not run
> until a subscription points topics at it.
>
> **Step 8 is per environment.** A Delivery key is scoped per environment, so a
> key that lacks the app's environment makes every concept read return `404` —
> which looks exactly like a missing API route. Titles then **stop being
> updated** rather than losing their notation; see
> [Failure behaviour](./docs/taxonomy-notation.md#failure-behaviour-read-this-first).

## How it works

Five topic documents, each canonical for its area:

| Document                                                     | Covers                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [Title composition](./docs/title-composition.md)             | Fragments, the `""`/`null` contract, withheld mount-time writes, authoring a new fragment |
| [Server-side propagation](./docs/server-side-propagation.md) | The Function dispatcher, topic routing, recursion safety, shared utilities                |
| [Publication date](./docs/publication-date.md)               | Releases vs. ScheduledActions, state transitions, retries, date/timezone                  |
| [Taxonomy notation](./docs/taxonomy-notation.md)             | Concept reads, the scoping table, failure behaviour, propagating concept edits            |
| [Build-time configuration](./docs/build-time-config.md)      | `__APP_DEFINITION_ID__` and `__DELIVERY_KEY__`, `envPrefix`, credential handling          |

`TODO.md` tracks deferred work. `AGENTS.md` is maintainer/agent guidance.

## Local Setup

1. Clone this repo.
2. Ensure Node v22 or later — with [NVM](https://github.com/nvm-sh/nvm), just
   `nvm use` in the repo root.
3. `npm install`.
4. `cp .env.example .env` and fill in the values ([below](#environment-variables)).
5. `npm run build` to create the `build/` directory that gets uploaded.
6. `npm run dev` runs the **frontend** locally on
   [localhost:3000](http://localhost:3000). The backend Functions only work once
   uploaded to Contentful.

### Environment variables

| Variable                  | Used for                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CONTENTFUL_ORG_ID`       | Identifies the org for `upload-ci` / `upsert-actions-ci`.                                             |
| `CONTENTFUL_APP_DEF_ID`   | **Required at build time** — inlined into the function bundles. The build fails without it.           |
| `CONTENTFUL_ACCESS_TOKEN` | A personal access token, used by `upload`, `upload-ci`, `upsert-actions`, and `import-content-model`. |
| `CONTENTFUL_DELIVERY_KEY` | A read-only Delivery API key, for taxonomy concept reads in both the editor and the function.         |

**`CONTENTFUL_ACCESS_TOKEN`: the name is not ours to choose**, so don't "clean it
up" to `CONTENTFUL_MANAGEMENT_TOKEN`. `@contentful/app-scripts` hardcodes it
(`ACCESS_TOKEN_ENV_KEY = 'CONTENTFUL_ACCESS_TOKEN'` in its `constants.js`) with
no flag to override, and the _interactive_ `npm run upload` reads it straight
from the environment — rename it and every upload prompts for a browser OAuth
paste instead. The CLI also **writes this name back into `.env`** after such a
prompt, so a rename gets silently re-added alongside it.

Both `CONTENTFUL_APP_DEF_ID` and `CONTENTFUL_DELIVERY_KEY` are **inlined into the
bundles at build time**, because a deployed Contentful Function has no
environment-variable mechanism. That has real consequences for rotation and for
what the uploaded artifact contains:
[Build-time configuration](./docs/build-time-config.md).

## App Definition Setup

1. Navigate to your Contentful Organization overview and click **Apps**.
2. Click **Create app** at the top right.
3. Add a **Title** and set the hosting URL to `http://localhost:3000` for now,
   just so the definition can be saved.
4. Under **Locations**, select **Entry field** and the **Short text** field type.
5. Click **Save**.

## Uploading a bundle to Contentful

1. With the App Definition created, fill `.env` — the App Definition ID comes
   from the config screen above.
2. `npm run build && npm run upload` builds the bundle and uploads it in one
   step.

## Content Type Configuration

1. Install the app to your chosen Space.
2. Edit your chosen title field in the content model and apply your App
   Definition to the field's **appearance**.

This repo ships an example content model at `exports/space/export.json` that you
can import into a blank space for a head start — see
[Importing a Space Export](#importing-a-space-export).

**To change what the title is composed of**, edit `src/fragments/index.ts` — the
one place fragments are ordered and the field ids (`description`, `regions`) and
taxonomy scheme ids (`division`, `brand`) are set. There is no per-content-type
configuration UI. See [Title composition](./docs/title-composition.md).

## Configuration for server-side propagation (App Events)

[Contentful App Events documentation](https://www.contentful.com/developers/docs/extensibility/app-framework/app-events/)

Cross-entry behaviour — a renamed Region flowing out to its parents, a Release
schedule appearing in a title — runs in a single Contentful Function,
`autoEntryTitleHandler`. It is declared in the manifest and bundled by
`npm run build`, but **does not run until an App Event Subscription points topics
at it.** That subscription is a one-time, per-App-Definition setup, done manually
in the web UI.

What the function does with each topic, and why it is one dispatcher rather than
several handlers, is in
[Server-side propagation](./docs/server-side-propagation.md).

### One-time setup

Do this once, after the app has been uploaded and activated for the first time.
You'll need org admin access.

1. In the Contentful web app, switch to the organization that owns this App
   Definition.
2. Open **Org Settings → Apps → [the "Auto Entry Title" app definition]**.
3. Open the **Events** tab.
4. **Target**: choose **Function**, then select `autoEntryTitleHandler` as the
   **App event handler**. Leave the filter and transformation slots empty.
5. **Content Events**: enable all nine of the following:
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

7. **Authorize the Delivery key for the app's environment** — Space →
   **Settings → API keys** → the key used for `CONTENTFUL_DELIVERY_KEY` → add
   every environment the app is installed in. Taxonomy is org-level, so the
   concepts are identical in every environment; this step is purely about _key
   authorization_. Skip it and every concept read 404s, at which point the
   function **stops updating titles** rather than writing them without the
   notation.
8. **Put the key in `.env` as `CONTENTFUL_DELIVERY_KEY`, then build and upload.**
   `npm run build` inlines it into both function bundles and `npm run upload`
   delivers it. There is no installation parameter and no console step, and
   **rotating the key requires a rebuild and re-upload** — see
   [Build-time configuration](./docs/build-time-config.md).
9. **Create the App Action** — `npm run upsert-actions` (interactive) or
   `npm run upsert-actions-ci`. This registers `recomputeConceptTitles` from the
   manifest's `actions[]` block. See
   [Propagating concept edits](./docs/taxonomy-notation.md#propagating-concept-edits).

There is no content-type filter at the subscription level, and none is needed:
`recomputeTitleForEntries` only writes to entries whose title field is bound to
this app, so unrelated content types incur a single index lookup at most.
Subscribing to all nine topics is correct and expected.

### Verifying the subscription

After saving:

1. In the Events tab, confirm the subscription is listed with all **nine** topics
   → `autoEntryTitleHandler` as the handler.
2. **Linked-entry rename test.** In a sandbox space, create an entry of a
   referenced content type (a `region` titled "EMEA", say) and reference it from
   a parent entry. Confirm the parent's title shows "EMEA" — that's the editor
   `subscribe` path, no function involved. Close the parent. Rename the
   referenced entry to "Europe" and publish it. Reopen the parent: its title
   should now read "Europe".
3. **Release schedule test.** Create a Launch Release containing a managed entry
   and schedule it. After the function runs, the entry's title should carry the
   date prefix (`Jul-04 - …`). Reschedule, then unschedule — the title should
   update to the new date, then drop the date entirely.
4. **Taxonomy test.** On an entry's **Taxonomy** tab, add a concept from the
   `division` or `brand` scheme, then switch back to the **Editor** tab. The
   notation blob should appear. (It updates on tab switch, not at the moment you
   assign it — [this is expected](./docs/taxonomy-notation.md#expected-the-title-updates-when-you-switch-back-to-the-editor-tab).)
5. If any test fails, check the **Function logs** on the **Functions** tab for
   `autoEntryTitleHandler`. They surface the topic that fired and any per-entry
   errors. **Titles that stop updating entirely** point at the delivery key —
   grep the logs for `no delivery key was inlined` or
   `conceptNotation`.

### Re-running / changing the subscription

The subscription persists at the App Definition level — redeploying the function
bundle does **not** require re-creating it. You only need to revisit this UI
when you change which topics the function should accept (adding
`Entry.unpublish` later, say), or if the subscription was deleted. Editing in
place is supported: toggle topics, change the target function, save.

### Required app permissions

The App Definition needs CMA permissions sufficient for **entry reads and
writes**, so the function can read editor interfaces and patch entries. These are
configured on the App Definition itself in the org-level settings, not in the
Events tab. If the function logs `forbidden` or `unauthorized`, that's the place
to check.

**Taxonomy reads are the exception: they don't go through app identity at all**,
so granting more CMA permissions will never fix a failing concept read — check
the key's environment authorization instead. Why that is structural, not a
permissions gap:
[the scoping table](./docs/taxonomy-notation.md#where-taxonomy-actually-lives-the-scoping-table).

## Importing a Space Export

1. Drop one or more `contentful space export` JSON dumps in `exports/space/`.
   This repo ships `exports/space/export.json` as a ready-to-use example content
   model.
2. Make sure the target space is blank — `contentful-import` is idempotent by
   entity `sys.id`, so re-running against a populated space _updates_ matching
   entities in place rather than failing.
3. `npm run import-content-model`. The script lists every `.json` in
   `exports/space/` and (if there's more than one) asks which to use, then
   prompts for space ID, environment ID, and a y/N confirm. Pass `--yes` to skip
   the confirm in scripted environments.
4. The chosen export is sent through `contentful-import` in full — content types,
   editor interfaces, locales, tags, entries, and assets with binaries. CMA
   errors surface verbatim, including a `details:` block.

The token is read from `CONTENTFUL_ACCESS_TOKEN` in `.env`. Space and environment
IDs are prompted for each run rather than read from `.env`, since they change per
environment.

## Available Scripts

#### `npm run dev`

Runs the frontend in development mode on
[localhost:3000](http://localhost:3000), reloading on edits. (`npm start` is a
byte-identical alias, kept only so muscle memory works.) The backend Functions
are not exercised locally — they have to be uploaded.

#### `npm run build`

Builds the app for production into `build/`, **and** bundles both Functions via
`build:functions`. Requires `CONTENTFUL_APP_DEF_ID`; warns but continues without
`CONTENTFUL_DELIVERY_KEY`.

Note this does **not** typecheck — `vite build` and vitest both only transpile.
Run `npx tsc --noEmit` for that.

#### `npm run test:ci`

Vitest in run-once mode. Use this rather than `npm test`, which is watch mode.

#### `npm run upload`

Uploads `build/` to Contentful and creates a bundle that is automatically
activated, prompting for every required argument.
[More on the deployment process](https://www.contentful.com/developers/docs/extensibility/app-framework/create-contentful-app/#deploy-with-contentful).

#### `npm run upload-ci`

The same upload, non-interactive: all arguments come from the environment.
Requires `CONTENTFUL_ORG_ID`, `CONTENTFUL_APP_DEF_ID`, and
`CONTENTFUL_ACCESS_TOKEN`.

#### `npm run upsert-actions`

Registers the App Actions declared in the `actions[]` block of
`contentful-app-manifest.json` against the App Definition — currently just
`recomputeConceptTitles`. Interactive; `npm run upsert-actions-ci` reads the same
env trio as `upload-ci`.

Run it once at setup, and again whenever an action's name, description, or
parameters change in the manifest.

> **Note:** this command **rewrites `contentful-app-manifest.json` in place**,
> stamping the remote action id into each entry and reformatting the file. That
> is `@contentful/app-scripts` behaviour, not ours. Expect a diff, and commit it
> — the stamped id is what makes subsequent runs an update rather than a
> duplicate create.

#### `npm run import-content-model`

Picks a `.json` export from `exports/space/` and imports it in full. See
[Importing a Space Export](#importing-a-space-export).

## Libraries to use

To make an app look and feel like Contentful:

- [Forma 36](https://f36.contentful.com/) — Contentful's design system
- [Contentful Field Editors](https://www.contentful.com/developers/docs/extensibility/field-editors/)
  — Contentful's field editor React components

## Learn More

[Read more](https://www.contentful.com/developers/docs/extensibility/app-framework/create-contentful-app/)
about the App Framework and the `create-contentful-app` CLI.
