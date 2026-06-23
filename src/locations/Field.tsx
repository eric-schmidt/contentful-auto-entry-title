import { useEffect } from "react";
import { useSDK } from "@contentful/react-apps-toolkit";
import { SingleLineEditor } from "@contentful/field-editor-single-line";
import type { FieldAppSDK } from "@contentful/app-sdk";
import { composition } from "../strategies";
import { joinFragments } from "../strategies/compose";
import type { FragmentEmitter } from "../strategies/types";

const Field = () => {
  const sdk = useSDK<FieldAppSDK>();

  useEffect(() => {
    sdk.window.startAutoResizer();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const separator = composition.separator ?? "";
    // `null` slots represent strategies that have called emit.skip() — they're
    // function-managed and have no editor opinion. While any slot is null,
    // recompute does NOT write, preserving the server-written value on the
    // field and avoiding silent overwrites on remount.
    const fragments: (string | null)[] = composition.fragments.map(() => "");

    const recompute = () => {
      if (fragments.some((s) => s === null)) return;
      const next = joinFragments(fragments as string[], separator);
      const current = sdk.field.getValue();
      if (next !== current) {
        sdk.field.setValue(next);
      }
    };

    const teardowns = composition.fragments.map((strategy, index) => {
      const emit = ((value: string) => {
        fragments[index] = value;
        recompute();
      }) as FragmentEmitter;
      emit.skip = () => {
        fragments[index] = null;
        recompute();
      };
      return strategy.subscribe({ sdk, emit });
    });

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
      isInitiallyDisabled={true}
      isDisabled
    />
  );
};

export default Field;
