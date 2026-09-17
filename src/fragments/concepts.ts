// Purpose: Taxonomy concept reads and the pure notation-joining logic shared by
// the `conceptNotation` fragment's two phases. Both phases use the SAME
// transport built here — `createCdaConceptReader`, a plain `fetch` against the
// CDA — because the App SDK's CMA proxy cannot reach concepts at all (see
// `conceptReaderBrowser.ts`). Only the source of the delivery key differs:
// an esbuild define in the Function (`conceptReaderForFunction.ts`), Vite's
// `import.meta.env` in the editor (`conceptReaderBrowser.ts`).
//
// Keep this module free of `contentful-management`: `src/fragments/index.ts` is
// imported by the Function bundle (via
// functions/shared/recomputeTitleForEntries.ts), so anything imported here gets
// bundled into the Function, and `createClient` would drag axios in — the exact
// dependency that fails inside the Functions runtime with
// `Unknown adapter 'fetch'`. Plain `fetch` is also the only transport available
// to both runtimes.
//
// Why reads are per-scheme rather than per-concept: neither the CDA nor the
// management SDK offers a concept-id filter (`GetManyConceptParams` accepts
// `conceptScheme` and a free-text `query`, nothing else), while both filter by
// scheme — and the schemes in play hold a handful of concepts each. So we fetch
// each scheme once and index locally.

import type { ConceptReader, ConceptRecord } from "./types";

// One concept scheme's concepts, paired with the scheme they came from. The
// array order of `SchemeConcepts[]` is the output order of the notation blob.
export type SchemeConcepts = {
  schemeId: string;
  concepts: ConceptRecord[];
};

const CDA_HOST = "cdn.contentful.com";
// The CDA caps `limit` at 1000; asking for the max keeps single-scheme reads to
// one request in practice while `pages.next` handling covers growth.
const CDA_PAGE_LIMIT = 1000;
// Safety valve on cursor pagination. A malformed or self-referential
// `pages.next` would otherwise loop forever inside a Function invocation.
const MAX_PAGES = 20;

// A concept's contribution: its notations sorted and concatenated. Sorting
// makes the output independent of the order an editor happened to add them in.
// A concept with no usable notation contributes nothing.
const notationForConcept = (concept: ConceptRecord): string =>
  [...(concept.notations ?? [])]
    .filter((notation) => typeof notation === "string" && notation !== "")
    .sort()
    .join("");

// Pure core, shared by `subscribe` and `compute` — the single place the
// two-phase contract can be checked for agreement.
//
// `schemes` is both the filter and the output order: a concept on the entry
// that belongs to none of them is ignored, and the blob is assembled scheme by
// scheme regardless of the order `metadata.concepts` happens to list them in.
// Within a scheme, concepts are ordered by (notation, id) so the result is
// stable. Everything joins with "" — the composition's " - " separator must
// never land inside the blob, so this has to be ONE fragment string.
export const notationForSchemes = (
  conceptIds: string[],
  schemes: SchemeConcepts[],
): string => {
  const present = new Set(conceptIds);

  return schemes
    .map(({ concepts }) =>
      concepts
        .filter((concept) => present.has(concept.id))
        .map((concept) => ({
          id: concept.id,
          notation: notationForConcept(concept),
        }))
        .filter(({ notation }) => notation !== "")
        .sort(
          (a, b) =>
            a.notation.localeCompare(b.notation) || a.id.localeCompare(b.id),
        )
        .map(({ notation }) => notation)
        .join(""),
    )
    .join("");
};

// Fetches every scheme in `schemeIds` and reduces to the notation blob.
// Rejects if any read fails — callers decide whether that's a warn-and-empty
// (both current callers do exactly that).
export const resolveConceptNotation = async ({
  conceptIds,
  schemeIds,
  reader,
}: {
  conceptIds: string[];
  schemeIds: string[];
  reader: ConceptReader;
}): Promise<string> => {
  if (conceptIds.length === 0) return "";

  const schemes = await Promise.all(
    schemeIds.map(async (schemeId) => ({
      schemeId,
      concepts: await reader(schemeId),
    })),
  );

  return notationForSchemes(conceptIds, schemes);
};

type CdaConcept = {
  sys?: { id?: string };
  notations?: string[];
};

type CdaConceptCollection = {
  items?: CdaConcept[];
  pages?: { next?: string };
};

const toConceptRecords = (payload: CdaConceptCollection): ConceptRecord[] =>
  (payload.items ?? []).flatMap((item) =>
    typeof item.sys?.id === "string"
      ? [{ id: item.sys.id, notations: item.notations ?? [] }]
      : [],
  );

// Delivery API transport, for the Function. `context.cma` cannot serve this:
// there is no space-scoped CMA taxonomy route at all (it 404s), and building a
// `contentful-management` client inside a Function throws
// `Unknown adapter 'fetch'`. The org-scoped CMA would work but needs a
// management token; the CDA needs only a read-only delivery key.
//
// Uses platform `fetch` and no Node imports, keeping the no-polyfill rule in
// esbuild.functions.config.js intact.
export const createCdaConceptReader = ({
  spaceId,
  environmentId,
  deliveryKey,
  host = CDA_HOST,
}: {
  spaceId: string;
  environmentId: string;
  deliveryKey: string;
  host?: string;
}): ConceptReader => {
  return async (schemeId: string): Promise<ConceptRecord[]> => {
    const first = new URL(
      `https://${host}/spaces/${spaceId}/environments/${environmentId}/taxonomy/concepts`,
    );
    first.searchParams.set("conceptScheme", schemeId);
    first.searchParams.set("limit", String(CDA_PAGE_LIMIT));

    const records: ConceptRecord[] = [];
    let url: string | undefined = first.toString();

    for (let page = 0; page < MAX_PAGES && url; page += 1) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${deliveryKey}` },
      });
      if (!response.ok) {
        throw new Error(
          `CDA taxonomy read for scheme "${schemeId}" failed with ${response.status}. ` +
            "If this is a 404, the delivery key is most likely not authorized " +
            `for environment "${environmentId}" — the route itself exists.`,
        );
      }

      const payload = (await response.json()) as CdaConceptCollection;
      records.push(...toConceptRecords(payload));

      // Cursor pagination: the CDA returns no `total`, only a `pages.next`
      // carrying an opaque `pageNext` token. Resolving it against the request
      // URL handles both absolute and relative forms.
      const next = payload.pages?.next;
      url = next ? new URL(next, url).toString() : undefined;
    }

    return records;
  };
};

// Memoizes per scheme, in-flight promises included, so overlapping fragment
// renders share one request.
//
// EDITOR ONLY, and never invalidated for the session — this is the deliberate
// staleness policy documented in AGENTS.md "Editor-side staleness": if a
// notation is edited in another tab, the editor stays stale until the entry is
// reopened, and the server-side path is authoritative. Do not add refresh logic here. The Function builds an
// UNCACHED reader per invocation, since a stale cache there would defeat the
// point of the propagation action.
//
// Rejections are evicted rather than cached: a transient network failure must
// not poison the scheme for the life of the page.
export const withConceptCache = (reader: ConceptReader): ConceptReader => {
  const cache = new Map<string, Promise<ConceptRecord[]>>();

  return (schemeId: string) => {
    const cached = cache.get(schemeId);
    if (cached) return cached;

    const pending = reader(schemeId).catch((err) => {
      cache.delete(schemeId);
      throw err;
    });
    cache.set(schemeId, pending);
    return pending;
  };
};
