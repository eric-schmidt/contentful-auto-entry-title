// Purpose: The only mounted App SDK location. Drives the live composition:
// instantiates every fragment's `subscribe` once, recomputes the joined
// title on each emit, and writes back to `sdk.field` (skip on no-op, and skip
// when any fragment reports an unknown value). The rendered SingleLineEditor is
// intentionally disabled — see the inline note for why field-level perms are the
// only correct way to enforce read-only.

import { useEffect } from "react";
import { useSDK } from "@contentful/react-apps-toolkit";
import { SingleLineEditor } from "@contentful/field-editor-single-line";
import type { FieldAppSDK } from "@contentful/app-sdk";
import { composition } from "../fragments";
import { joinFragments } from "../fragments/compose";
import { withConceptCache } from "../fragments/concepts";
import { createBrowserConceptReader } from "../fragments/conceptReaderBrowser";
import type { ConceptReader } from "../fragments/types";

// Module scope, not per-mount: the cache must outlive remounts for opening the
// same entry twice to be free. Keyed by space+environment so a dev session that
// switches environments doesn't serve the wrong org's concepts. Never
// invalidated for the session — the deliberate staleness policy documented in
// AGENTS.md "Editor-side staleness" and docs/title-composition.md; the
// server-side path is authoritative.
const conceptReaders = new Map<string, ConceptReader | undefined>();

const conceptReaderFor = (sdk: FieldAppSDK): ConceptReader | undefined => {
  const key = `${sdk.ids.space}/${sdk.ids.environment}`;
  if (conceptReaders.has(key)) return conceptReaders.get(key);

  const base = createBrowserConceptReader(sdk);
  // May be undefined when no key was built in; `conceptNotation` then warns and
  // returns `null` — "could not find out" — so the whole title is withheld and
  // the stored one is left alone. It does NOT emit "": that would persist a
  // title missing its notation. Cached either way so the warning fires once.
  const reader = base ? withConceptCache(base) : undefined;
  conceptReaders.set(key, reader);
  return reader;
};

const Field = () => {
  const sdk = useSDK<FieldAppSDK>();

  useEffect(() => {
    sdk.window.startAutoResizer();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const separator = composition.separator ?? "";
    // `null` until a fragment's first emit — every fragment starts UNKNOWN, not
    // empty. This is what stops the first paint from writing a title assembled
    // from slots that simply hadn't answered yet: a stored `MRRL` used to be
    // stripped the moment the entry opened, before the async taxonomy read
    // resolved, and the web app autosaved that.
    const fragments: (string | null)[] = composition.fragments.map(() => null);

    const recompute = () => {
      const next = joinFragments(fragments, separator);
      // `null` means at least one fragment couldn't determine its contribution.
      // Writing anyway would persist a title that looks complete while missing a
      // piece — deleting real data. Leave the stored value alone; the
      // server-side path stays authoritative. See src/fragments/compose.ts.
      if (next === null) return;

      const current = sdk.field.getValue();
      if (next !== current) {
        sdk.field.setValue(next);
      }
    };

    const conceptReader = conceptReaderFor(sdk);

    const teardowns = composition.fragments.map((fragment, index) =>
      fragment.subscribe({
        sdk,
        conceptReader,
        emit: (value) => {
          fragments[index] = value;
          recompute();
        },
      }),
    );

    return () => {
      teardowns.forEach((fn) => fn());
    };
  }, [sdk]);

  // It's not possible to disable a field from editing via the UI when it is
  // marked as the title. Use field-level perms to mark this field read-only
  // for relevant roles instead.
  return (
    <SingleLineEditor field={sdk.field} locales={sdk.locales} isDisabled />
  );
};

export default Field;
