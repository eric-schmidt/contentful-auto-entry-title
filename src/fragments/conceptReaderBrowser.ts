// Purpose: The editor's ConceptReader transport — the same CDA `fetch` the
// Function uses, with the delivery key exposed to the browser bundle through an
// `envPrefix` entry in vite.config.mts.
//
// Why NOT `sdk.cmaAdapter` (the approach this file replaces): the App SDK's CMA
// proxy enforces a hardcoded entity allowlist — see `CMAClient` in
// @contentful/app-sdk/dist/types/cmaClient.types.d.ts, which enumerates ~40
// entity types and does NOT include `concept`. Calling it anyway fails at
// runtime with:
//
//   You can not access the entity type Concept from within an app.
//
// That is the proxy refusing to route, not a permissions problem: `cmaAdapter`
// is scoped to /spaces/{id}/environments/{id}, and taxonomy is ORG-level, so no
// grant, key, or cast can reach concepts through it. The missing `concept` key
// on the `CMAClient` type was the API telling the truth, not a typing gap.
//
// App Actions were the other candidate and were rejected: they are
// asynchronous-by-design with no synchronous response (you poll
// `createWithResult`), which would delay the title paint by seconds on every
// entry open.
//
// The accepted cost: a read-only, space-scoped Delivery key ships in the
// browser bundle Contentful serves. That is the ordinary way CDA keys are used
// in browser apps — it grants published-read on this space and nothing more —
// but it is a real change from "the editor needs no credential at all". Never
// put the MANAGEMENT token behind a `VITE_` prefix.
//
// Verified prerequisite: the CDA taxonomy endpoint is browser-callable —
// `access-control-allow-origin: *` with `authorization` among the allowed
// headers. No proxy needed.

import type { FieldAppSDK } from "@contentful/app-sdk";
import { createCdaConceptReader } from "./concepts";
import type { ConceptReader } from "./types";

// Vite statically replaces `import.meta.env.*` at build time. Reaching the
// browser at all requires the var to match an `envPrefix` entry — vite.config.mts
// lists `CONTENTFUL_DELIVERY_KEY` by its exact full name, so `.env` stays the
// single source and no `VITE_`-prefixed duplicate has to be kept in sync. It is
// undefined rather than absent when unset, so this needs no try/catch (unlike
// the Function's `__DELIVERY_KEY__` global).
const browserDeliveryKey = (): string =>
  import.meta.env.CONTENTFUL_DELIVERY_KEY ?? "";

// Returns undefined when no key was built in, which `conceptNotation` already
// handles by warning and emitting "" — the same degradation as the Function.
export const createBrowserConceptReader = (
  sdk: FieldAppSDK,
): ConceptReader | undefined => {
  const deliveryKey = browserDeliveryKey();

  if (!deliveryKey) {
    console.warn(
      "[auto-entry-title] no CONTENTFUL_DELIVERY_KEY was built into the " +
        "editor bundle, so taxonomy notations will be omitted from the title. " +
        'Set it in .env and rebuild — see README "One-time setup".',
    );
    return undefined;
  }

  return createCdaConceptReader({
    spaceId: sdk.ids.space,
    environmentId: sdk.ids.environment,
    deliveryKey,
  });
};
