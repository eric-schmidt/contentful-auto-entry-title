This project was bootstrapped with [Create Contentful App](https://github.com/contentful/create-contentful-app).

## Overview

The main goal of this app is to automatically generate the value of an entry's title field by composing an ordered list of fragment strategies — small modules that each contribute one piece of the final string (e.g., a value pulled from another field, a Launch Release scheduled date, a fixed prefix). Fragments are concatenated with a configurable separator and written to the field on which the app is mounted.

This app is intended for non-localized entry-title fields. The composed value is written via `sdk.field.setValue`, which targets the locale of the mounted field.

## Deployment

This app uses https://github.com/contentful/actions-app-deploy to automatically deploy to Contentful when changes are pushed up to GitHub. Configuration for this process can be found in the `.github/workflows/actions-app-deploy.yml` file.

## App/Content Type Configuration

1. Install the app to your space, either via Contentful hosting or by cloning this repo and running `npm install` and `npm start` (hosted at http://localhost:3000).
2. Enable for Short Text entry fields (the only field type currently supported).
3. Create a Short Text field on a content type and edit its appearance to use the Auto Field Value widget.

## Configuring naming behavior

Naming behavior is composed from an ordered list of fragment strategies in `src/strategies/index.ts`. Edit the `composition` export to add, remove, or reorder fragments, then rebuild and redeploy:

```ts
export const composition: FieldNameComposition = {
  fragments: [staticString("Auto Title")],
  separator: " - ",
};
```

A fragment strategy is any function matching the `FragmentStrategy` signature in `src/strategies/types.ts`. It receives the SDK plus an `emit(fragment)` callback, subscribes to whatever it needs, and returns a teardown that removes its listeners. `Field.tsx` joins each fragment's most-recent emitted value with the separator and writes the result to the field (skipping the write when the composed value already matches).

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
