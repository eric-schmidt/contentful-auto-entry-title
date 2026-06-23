import type { FragmentStrategy } from "./types";

type FieldValueOptions = {
  fieldId: string;
};

export const fieldValue = ({ fieldId }: FieldValueOptions): FragmentStrategy => {
  return ({ sdk, emit }) => {
    const field = sdk.entry.fields[fieldId];
    if (!field) {
      console.warn(
        `[auto-field-value] fieldValue strategy: no field with id "${fieldId}" on this content type.`,
      );
      return () => {};
    }

    return field.onValueChanged((value: unknown) => {
      emit(typeof value === "string" ? value : "");
    });
  };
};
