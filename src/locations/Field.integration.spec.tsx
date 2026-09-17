// Purpose: End-to-end editor coverage — the REAL composition, the REAL
// `conceptNotation`, and the REAL notation-joining logic wired through the real
// `Field.tsx`. Only the HTTP transport is stubbed.
//
// Why this exists alongside `Field.spec.tsx`: that spec mocks `../fragments`
// wholesale, so it pins the write/withhold logic but can't catch a break in the
// path from a metadata event to a shortened stored title. Concept ADDITION was
// verified live while REMOVAL was not, and a title that grows correctly but
// never shrinks is exactly the asymmetry neither existing layer would fail on.
//
// It also documents the boundary this suite cannot reach: everything here
// starts from a `metadataChanged` dispatch. Whether the Contentful web app
// actually dispatches one on a concept removal is a host behaviour, verifiable
// only in the browser.

import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConceptRecord } from "../fragments/types";
import { setCurrentSdk } from "./fieldEditorMocks";

const CONCEPTS_BY_SCHEME: Record<string, ConceptRecord[]> = {
  division: [{ id: "mens", notations: ["M"] }],
  brand: [{ id: "doubleRl", notations: ["RRL"] }],
};

// The only stub: the CDA transport. Everything downstream of it is real code.
vi.mock("../fragments/conceptReaderBrowser", () => ({
  createBrowserConceptReader: () => async (schemeId: string) =>
    CONCEPTS_BY_SCHEME[schemeId] ?? [],
}));

// Shared with Field.spec.tsx so the two stubs cannot drift — see
// ./fieldEditorMocks.
vi.mock("@contentful/react-apps-toolkit", async () =>
  (await import("./fieldEditorMocks")).reactAppsToolkitMock(),
);
vi.mock("@contentful/field-editor-single-line", async () =>
  (await import("./fieldEditorMocks")).singleLineEditorMock(),
);

let currentSdk: ReturnType<typeof buildSdk>;
const useSdk = (next: ReturnType<typeof buildSdk>) => {
  currentSdk = next;
  setCurrentSdk(next);
  return next;
};

import Field from "./Field";

const conceptLinks = (ids: string[]) =>
  ids.map((id) => ({
    sys: { type: "Link" as const, linkType: "TaxonomyConcept" as const, id },
  }));

// `subscribe` resolves through several chained microtasks (per-scheme reads,
// then the join), so a few drains are needed before the title settles.
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const buildSdk = (initialConceptIds: string[]) => {
  let value = "";
  let metadata: unknown = {
    tags: [],
    concepts: conceptLinks(initialConceptIds),
  };
  let metadataListener: ((m?: unknown) => void) | undefined;

  return {
    locales: { available: ["en-US"], default: "en-US" },
    ids: { space: "s1", environment: "taxonomy", organization: "o1" },
    cmaAdapter: { makeRequest: vi.fn() },
    contentType: { name: "PDP Page", sys: { id: "pdpPage" } },
    window: { startAutoResizer: vi.fn() },
    field: {
      id: "title",
      locale: "en-US",
      getValue: () => value,
      setValue: vi.fn((next: string) => {
        value = next;
      }),
    },
    // `publicationDate` runs a CMA lookup; an entry in no release contributes
    // "", which is all this spec needs from it.
    cma: {
      entry: { get: vi.fn() },
      scheduledActions: { getMany: vi.fn(async () => ({ items: [] })) },
    },
    entry: {
      getSys: () => ({ id: "e1" }),
      getMetadata: () => metadata,
      onMetadataChanged: (cb: (m?: unknown) => void) => {
        metadataListener = cb;
        // Mirrors the SDK: `onMetadataChanged` is a MemoizedSignal, so it
        // fires synchronously on attach with the current value.
        cb(metadata);
        return () => {};
      },
      fields: {
        description: {
          onValueChanged: (cb: (v: unknown) => void) => {
            cb("desc");
            return () => {};
          },
        },
        regions: {
          onValueChanged: (cb: (v: unknown) => void) => {
            cb([]);
            return () => {};
          },
        },
      },
    },
    // Test-only helper: emulate the web app dispatching a metadata change.
    __setConcepts: (ids: string[]) => {
      metadata = { tags: [], concepts: conceptLinks(ids) };
      metadataListener?.(metadata);
    },
    __title: () => value,
  };
};

describe("Field + real conceptNotation: taxonomy concept changes", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the notation blob on mount", async () => {
    useSdk(buildSdk(["mens", "doubleRl"]));

    render(<Field />);
    await settle();

    expect(currentSdk.__title()).toBe("MRRL - desc - PDP Page");
  });

  it("shortens the blob when one concept is removed", async () => {
    useSdk(buildSdk(["mens", "doubleRl"]));

    render(<Field />);
    await settle();
    expect(currentSdk.__title()).toContain("MRRL");

    currentSdk.__setConcepts(["mens"]);
    await settle();

    expect(currentSdk.__title()).toBe("M - desc - PDP Page");
  });

  it("drops the blob entirely when the last concept is removed", async () => {
    useSdk(buildSdk(["mens"]));

    render(<Field />);
    await settle();
    expect(currentSdk.__title()).toBe("M - desc - PDP Page");

    currentSdk.__setConcepts([]);
    await settle();

    // No orphan separator where the blob used to be.
    expect(currentSdk.__title()).toBe("desc - PDP Page");
  });

  it("grows the blob again when a concept is re-added", async () => {
    useSdk(buildSdk([]));

    render(<Field />);
    await settle();
    expect(currentSdk.__title()).toBe("desc - PDP Page");

    currentSdk.__setConcepts(["mens", "doubleRl"]);
    await settle();

    expect(currentSdk.__title()).toBe("MRRL - desc - PDP Page");
  });
});
