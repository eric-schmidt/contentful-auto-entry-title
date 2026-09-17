import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createBrowserConceptReader } from "./conceptReaderBrowser";

const buildSdk = () =>
  ({
    ids: { space: "space-1", environment: "taxonomy", organization: "org-1" },
  }) as never;

// `import.meta.env` is a live object under vitest, so tests set the key on it
// directly. Vite replaces the expression statically in a real build.
const setKey = (key: string | undefined) => {
  if (key === undefined) {
    delete (import.meta.env as Record<string, unknown>)
      .CONTENTFUL_DELIVERY_KEY;
    return;
  }
  (import.meta.env as Record<string, unknown>).CONTENTFUL_DELIVERY_KEY =
    key;
};

describe("createBrowserConceptReader", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    setKey(undefined);
    vi.unstubAllGlobals();
  });

  it("reads concepts over the CDA rather than the app's CMA proxy", async () => {
    // The whole point of this module: `sdk.cmaAdapter` cannot reach concepts
    // ("You can not access the entity type Concept from within an app"), so the
    // editor must hit cdn.contentful.com directly.
    setKey("browser-key");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ sys: { id: "doubleRl" }, notations: ["RRL"] }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const reader = createBrowserConceptReader(buildSdk());
    const records = await reader!("brand");

    expect(records).toEqual([{ id: "doubleRl", notations: ["RRL"] }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("https://cdn.contentful.com/spaces/space-1/");
    expect(url).toContain("/environments/taxonomy/taxonomy/concepts");
    expect(url).toContain("conceptScheme=brand");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer browser-key",
    );
  });

  it("returns undefined and warns when no key was built into the bundle", () => {
    setKey(undefined);

    expect(createBrowserConceptReader(buildSdk())).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("CONTENTFUL_DELIVERY_KEY"),
    );
  });

  it("treats an empty key as absent rather than sending `Bearer `", () => {
    setKey("");

    expect(createBrowserConceptReader(buildSdk())).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
