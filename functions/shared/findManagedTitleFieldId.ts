import type { EntryProps, PlainClientAPI } from "contentful-management";

// `__APP_DEFINITION_ID__` is inlined at build time by esbuild's `define` from
// `process.env.CONTENTFUL_APP_DEF_ID` (see esbuild.functions.config.js). The
// function context does not provide app-identity information at runtime, so
// we have to bake this constant in to identify which editor-interface
// controls were configured to use this app.

// Returns the field id of the title field on `entry`'s content type that is
// configured to use this app, or null if no such control exists. Matches
// `widgetNamespace === "app"` AND `widgetId === <App Definition ID>`.
export const findManagedTitleFieldId = async (
  cma: PlainClientAPI,
  entry: EntryProps,
): Promise<string | null> => {
  try {
    const editorInterface = await cma.editorInterface.get({
      contentTypeId: entry.sys.contentType.sys.id,
    });
    const control = editorInterface.controls?.find(
      (c) => c.widgetNamespace === "app" && c.widgetId === __APP_DEFINITION_ID__,
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
