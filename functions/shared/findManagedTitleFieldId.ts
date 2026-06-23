import type { EntryProps, PlainClientAPI } from "contentful-management";

// Returns the field id of the title field on `entry`'s content type that is
// configured to use the auto-entry-title app, or null if no such control exists.
// Both propagator functions call this to scope writes to fields actually
// managed by this app.
export const findManagedTitleFieldId = async (
  cma: PlainClientAPI,
  entry: EntryProps,
  appInstallationId: string,
): Promise<string | null> => {
  try {
    const editorInterface = await cma.editorInterface.get({
      contentTypeId: entry.sys.contentType.sys.id,
    });
    const control = editorInterface.controls?.find(
      (c) => c.widgetNamespace === "app" && c.widgetId === appInstallationId,
    );
    return control?.fieldId ?? null;
  } catch (err) {
    console.warn(
      `[auto-entry-title] failed to read editor interface for content type "${entry.sys.contentType.sys.id}".`,
      err,
    );
    return null;
  }
};

export const resolveDefaultLocale = async (
  cma: PlainClientAPI,
): Promise<string> => {
  const locales = await cma.locale.getMany({});
  return locales.items.find((l) => l.default)?.code ?? "en-US";
};
