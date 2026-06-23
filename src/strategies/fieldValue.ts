import type { FragmentStrategy } from "./types";

type FieldValueOptions = {
  fieldId: string;
};

const coerce = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const fieldValue = ({ fieldId }: FieldValueOptions): FragmentStrategy => ({
  subscribe: ({ sdk, emit }) => {
    const field = sdk.entry.fields[fieldId];
    if (!field) {
      console.warn(
        `[auto-entry-title] fieldValue strategy: no field with id "${fieldId}" on this content type.`,
      );
      return () => {};
    }

    return field.onValueChanged((value: unknown) => {
      emit(coerce(value));
    });
  },
  compute: async ({ entry, defaultLocale }) =>
    coerce(entry.fields?.[fieldId]?.[defaultLocale]),
});
