// Purpose: Two CMA-based lookups every recompute path needs:
//   - find the field id on a given entry's content type whose editor
//     interface is bound to this app (so we know which field to overwrite)
//   - resolve the space's default locale code
// The former is how the function avoids writing to entries that aren't
// using this app despite the event subscription firing for all entries.

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

// Memoizes `findManagedTitleFieldId` by content type id for the life of ONE
// invocation.
//
// Why this exists: the recompute loop runs over every entry that references the
// published one, and those entries overwhelmingly share a content type. Calling
// the unmemoized lookup per entry meant N identical `editorInterface.get`
// requests for a value that cannot change mid-invocation — and with the CMA
// capped at 7 requests/second, that was a direct cause of 429 storms (the
// give-away in the logs was the same `failed to read editor interface for
// content type "…"` line repeating within a single requestId).
//
// Per-invocation, NOT module scope: function instances are reused across
// invocations, so a module-level cache would keep serving a stale editor
// interface after someone rebinds the field in the web app.
//
// Failures memoize too — deliberately. The value is already error-tolerant
// (`null` means "skip this entry"), and retrying a failing content type once
// per entry is precisely the hammering this removes. The tradeoff: if that one
// read failed transiently, every entry of that content type is skipped for this
// invocation rather than some being retried. Skipping is the safer half — a
// later publish or the repair action picks them up, whereas hammering can take
// out the whole batch.
export const createManagedTitleFieldLookup = (
  cma: PlainClientAPI,
): ((entry: EntryProps) => Promise<string | null>) => {
  const byContentType = new Map<string, Promise<string | null>>();

  return (entry: EntryProps) => {
    const contentTypeId = entry.sys.contentType.sys.id;
    const cached = byContentType.get(contentTypeId);
    if (cached) return cached;

    const pending = findManagedTitleFieldId(cma, entry);
    byContentType.set(contentTypeId, pending);
    return pending;
  };
};

export const resolveDefaultLocale = async (
  cma: PlainClientAPI,
): Promise<string> => {
  const locales = await cma.locale.getMany({});
  return locales.items.find((l) => l.default)?.code ?? "en-US";
};
