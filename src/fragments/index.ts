// Purpose: The single source of truth for which fragments appear in the
// title, in what order, with which separator. Edit here to add/remove/reorder
// fragments — every other file just consumes `composition`. Field ids
// (`brands`, `regions`, `description`) are hardcoded to this customer's
// content model; making them configurable is out of scope until there's a
// second consumer.

import type { FieldNameComposition } from "./types";
import { fieldValue } from "./fieldValue";
import { contentType } from "./contentType";
import { referencedEntryTitle } from "./referencedEntryTitle";
import { publicationDate } from "./publicationDate";

export const composition: FieldNameComposition = {
  fragments: [
    publicationDate(),
    referencedEntryTitle({ fieldId: "brands" }),
    fieldValue({ fieldId: "description" }),
    contentType(),
    referencedEntryTitle({ fieldId: "regions" }),
  ],
  separator: " - ",
};
