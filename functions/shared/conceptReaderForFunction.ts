// Purpose: Builds the ConceptReader both function entry points need, from the
// build-time-inlined delivery key.
//
// Why a build-time `define` (`__DELIVERY_KEY__`) rather than an installation
// parameter: so that `.env` is the single place the key is configured. The
// constraint that forces one of these two choices is that a deployed Contentful
// Function has NO environment-variable mechanism — `.env` is a local build
// artifact and never reaches the function runtime. Nor can `context.cma` avoid
// the key: it acts as the app identity, which is scoped to one space
// environment and cannot read org-level taxonomy, and there is no space-scoped
// CMA taxonomy route at all.
//
// The accepted cost, spelled out because it is easy to forget: the key is
// embedded in the bundle uploaded to Contentful (`build/` is gitignored, so it
// stays out of version control), and ROTATING IT REQUIRES A REBUILD AND
// RE-UPLOAD. The key is read-only and space-scoped, which bounds the exposure.
// See esbuild.functions.config.js for the build side.
//
// The reader is deliberately UNCACHED. Function instances are reused across
// invocations, and a stale concept cache here would defeat the entire point of
// the propagation action — the caller invokes it precisely because a notation
// just changed. Only the editor caches (see src/locations/Field.tsx).

import { createCdaConceptReader } from "../../src/fragments/concepts";
import type { ConceptReader } from "../../src/fragments/types";

// Reads the inlined key defensively. In the deployed bundle esbuild has already
// replaced `__DELIVERY_KEY__` with a string literal, but under vitest (which
// transpiles the source, applying no `define`) the global may be absent
// entirely — so this must not throw a ReferenceError.
const inlinedDeliveryKey = (): string => {
  try {
    return typeof __DELIVERY_KEY__ === "string" ? __DELIVERY_KEY__ : "";
  } catch {
    return "";
  }
};

export const conceptReaderForFunction = ({
  spaceId,
  environmentId,
  context,
}: {
  spaceId: string;
  environmentId: string;
  // Names the calling flow in the warning, matching recomputeTitleForEntries.
  context: string;
}): ConceptReader | undefined => {
  const deliveryKey = inlinedDeliveryKey();

  if (!deliveryKey) {
    console.warn(
      `[auto-entry-title] ${context}: no delivery key was inlined at build ` +
        "time, so taxonomy notations will be omitted from every title this " +
        "invocation rewrites. Set CONTENTFUL_DELIVERY_KEY in .env, then " +
        "rebuild and re-upload — see README \"One-time setup\".",
    );
    return undefined;
  }

  return createCdaConceptReader({ spaceId, environmentId, deliveryKey });
};
