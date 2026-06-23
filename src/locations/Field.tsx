import { useEffect } from "react";
import { useSDK } from "@contentful/react-apps-toolkit";
import { SingleLineEditor } from "@contentful/field-editor-single-line";
import type { FieldAppSDK } from "@contentful/app-sdk";
import { composition } from "../fragments";
import { joinFragments } from "../fragments/compose";

const Field = () => {
  const sdk = useSDK<FieldAppSDK>();

  useEffect(() => {
    sdk.window.startAutoResizer();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const separator = composition.separator ?? "";
    const fragments: string[] = composition.fragments.map(() => "");

    const recompute = () => {
      const next = joinFragments(fragments, separator);
      const current = sdk.field.getValue();
      if (next !== current) {
        sdk.field.setValue(next);
      }
    };

    const teardowns = composition.fragments.map((fragment, index) =>
      fragment.subscribe({
        sdk,
        emit: (value) => {
          fragments[index] = value;
          recompute();
        },
      }),
    );

    return () => {
      teardowns.forEach((fn) => fn());
    };
  }, [sdk]);

  // It's not possible to disable a field from editing via the UI when it is
  // marked as the title. Use field-level perms to mark this field read-only
  // for relevant roles instead.
  return (
    <SingleLineEditor
      field={sdk.field}
      locales={sdk.locales}
      isDisabled
    />
  );
};

export default Field;
