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
