import type { FieldNameComposition } from "./types";
import { staticString } from "./staticString";
import { fieldValue } from "./fieldValue";
import { contentType } from "./contentType";

export const composition: FieldNameComposition = {
  fragments: [
    staticString("PUB_DATE_TODO"),
    staticString("BRAND_TODO"),
    fieldValue({ fieldId: "description" }),
    contentType(),
    staticString("REGION_TODO"),
  ],
  separator: " - ",
};
