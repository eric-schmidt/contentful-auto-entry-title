import { describe, it, expect, vi } from "vitest";

// Each fragment factory is replaced with one that records its name and options,
// so this spec asserts the composition's shape without running any fragment.
// `vi.hoisted` is required: vi.mock factories are hoisted above module-scope
// consts, so a plain `const sentinel` would not yet be initialized.
const { sentinel } = vi.hoisted(() => ({
  sentinel: (name: string) => (options?: unknown) => ({
    name,
    options,
    subscribe: () => () => {},
    compute: async () => "",
  }),
}));

vi.mock("./publicationDate", () => ({ publicationDate: sentinel("publicationDate") }));
vi.mock("./conceptNotation", () => ({ conceptNotation: sentinel("conceptNotation") }));
vi.mock("./fieldValue", () => ({ fieldValue: sentinel("fieldValue") }));
vi.mock("./contentType", () => ({ contentType: sentinel("contentType") }));
vi.mock("./referencedEntryTitle", () => ({
  referencedEntryTitle: sentinel("referencedEntryTitle"),
}));

import { composition } from "./index";

type Labelled = { name: string; options?: unknown };

const labels = () => (composition.fragments as unknown as Labelled[]).map((f) => f.name);

describe("composition", () => {
  it("composes exactly these five fragments, in this order", () => {
    expect(labels()).toEqual([
      "publicationDate",
      "conceptNotation",
      "fieldValue",
      "contentType",
      "referencedEntryTitle",
    ]);
  });

  it("places the notation blob immediately after the date", () => {
    // The stated requirement: the Division + Brand notations are appended to
    // the title directly after the publication date.
    expect(labels()[0]).toBe("publicationDate");
    expect(labels()[1]).toBe("conceptNotation");
  });

  it("reads the division and brand schemes, in that order", () => {
    const notation = (composition.fragments as unknown as Labelled[])[1];
    expect(notation.options).toEqual({ schemeIds: ["division", "brand"] });
  });

  it("no longer references a `brands` field — Brand is taxonomy-only", () => {
    const options = (composition.fragments as unknown as Labelled[]).map(
      (f) => f.options,
    );
    expect(options).not.toContainEqual({ fieldId: "brands" });
  });

  it("joins fragments with a spaced hyphen", () => {
    expect(composition.separator).toBe(" - ");
  });
});
