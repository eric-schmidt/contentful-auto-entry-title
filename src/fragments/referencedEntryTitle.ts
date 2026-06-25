// Purpose: Fragment that emits the title(s) of entries linked from a
// reference (or array-of-references) field on this entry, joined with "/".
// Cross-entry renames are propagated by the function side via the
// Entry.publish event subscription (see functions/handler/linkedEntryTitle.ts),
// not by editor-side polling — the editor only reflects renames on reopen.

import type { FragmentCmaClient, Fragment } from "./types";

type Options = {
  fieldId: string;
};

type Link = { sys: { type: "Link"; linkType: "Entry"; id: string } };

const isLink = (value: unknown): value is Link =>
  typeof value === "object" &&
  value !== null &&
  "sys" in value &&
  typeof (value as Link).sys?.id === "string";

const extractIds = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter(isLink).map((link) => link.sys.id);
  }
  if (isLink(value)) {
    return [value.sys.id];
  }
  return [];
};

const fetchTitle = async (
  cma: FragmentCmaClient,
  entryId: string,
  defaultLocale: string,
): Promise<string> => {
  try {
    const linked = await cma.entry.get({ entryId });
    const value = linked.fields?.title?.[defaultLocale];
    return typeof value === "string" ? value : "";
  } catch (err) {
    console.warn(
      `[auto-entry-title] referencedEntryTitle: failed to fetch entry "${entryId}".`,
      err,
    );
    return "";
  }
};

const resolveTitlesFromValue = async (
  value: unknown,
  cma: FragmentCmaClient,
  defaultLocale: string,
): Promise<string> => {
  const ids = extractIds(value);
  if (ids.length === 0) return "";

  const titles = await Promise.all(
    ids.map((id) => fetchTitle(cma, id, defaultLocale)),
  );
  return titles.filter((t) => t !== "").join("/");
};

export const referencedEntryTitle = ({ fieldId }: Options): Fragment => ({
  subscribe: ({ sdk, emit }) => {
    const field = sdk.entry.fields[fieldId];
    if (!field) {
      console.warn(
        `[auto-entry-title] referencedEntryTitle: no field with id "${fieldId}" on this content type.`,
      );
      return () => {};
    }

    return field.onValueChanged(async (value: unknown) => {
      emit(await resolveTitlesFromValue(value, sdk.cma, sdk.locales.default));
    });
  },
  compute: async ({ entry, cma, defaultLocale }) => {
    const value = entry.fields?.[fieldId]?.[defaultLocale];
    return resolveTitlesFromValue(value, cma, defaultLocale);
  },
});
