import type { FieldNameComposition } from "./types";
import { staticString } from "./staticString";

export const composition: FieldNameComposition = {
  fragments: [staticString("Auto Title")],
  separator: " - ",
};
