import type { FieldNameComposition } from "./types";
import { staticString } from "./staticString";
import { fieldValue } from "./fieldValue";
import { contentType } from "./contentType";
import { referencedEntryTitle } from "./referencedEntryTitle";
import { publicationDate } from "./publicationDate";

export const composition: FieldNameComposition = {
  fragments: [
    publicationDate(),
    staticString("BRAND_TODO"),
    fieldValue({ fieldId: "description" }),
    contentType(),
    referencedEntryTitle({ fieldId: "regions" }),
  ],
  separator: " - ",
};
