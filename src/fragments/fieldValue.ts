// Purpose: Fragment that emits the verbatim value of another short-text
// field on this same entry. In the editor it subscribes to onValueChanged;
// in the function it reads the persisted default-locale value. Non-string
// field values coerce to "" rather than throwing.

import type { Fragment } from "./types";

type FieldValueOptions = {
  fieldId: string;
};

const coerce = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const fieldValue = ({ fieldId }: FieldValueOptions): Fragment => ({
  subscribe: ({ sdk, emit }) => {
    const field = sdk.entry.fields[fieldId];
    if (!field) {
      console.warn(
        `[auto-entry-title] fieldValue fragment: no field with id "${fieldId}" on this content type.`,
      );
      // Emit "" rather than staying silent. A slot with no emit is UNKNOWN, and
      // Field.tsx withholds the whole title until every slot has answered — so
      // a misconfigured field id would freeze title updates entirely. A field
      // that doesn't exist has nothing to contribute, which is exactly "".
      emit("");
      return () => {};
    }

    return field.onValueChanged((value: unknown) => {
      emit(coerce(value));
    });
  },
  compute: async ({ entry, defaultLocale }) =>
    coerce(entry.fields?.[fieldId]?.[defaultLocale]),
});
