// Purpose: The single source of truth for which fragments appear in the
// title, in what order, with which separator. Edit here to add/remove/reorder
// fragments — every other file just consumes `composition`. Field ids
// (`regions`, `description`) and concept scheme ids (`division`, `brand`) are
// hardcoded to this customer's content model; making them configurable is out
// of scope until there's a second consumer.
//
// Note on the slot after the date: it used to be
// `referencedEntryTitle({ fieldId: "brands" })`, but Brand became
// taxonomy-only — `pdpPage` has no `brands` field any more, so that fragment
// warned and emitted "" on every render. `conceptNotation` replaces it and
// reads Brand from `metadata.concepts` instead.

import type { FieldNameComposition } from "./types";
import { fieldValue } from "./fieldValue";
import { contentType } from "./contentType";
import { referencedEntryTitle } from "./referencedEntryTitle";
import { publicationDate } from "./publicationDate";
import { conceptNotation } from "./conceptNotation";

export const composition: FieldNameComposition = {
  fragments: [
    publicationDate(),
    conceptNotation({ schemeIds: ["division", "brand"] }),
    fieldValue({ fieldId: "description" }),
    contentType(),
    referencedEntryTitle({ fieldId: "regions" }),
  ],
  separator: " - ",
};
