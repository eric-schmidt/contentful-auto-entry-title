import type { FieldAppSDK } from "@contentful/app-sdk";

export type FragmentEmitter = (fragment: string) => void;

export type FragmentStrategyContext = {
  sdk: FieldAppSDK;
  emit: FragmentEmitter;
};

export type FragmentStrategy = (ctx: FragmentStrategyContext) => () => void;

export type FieldNameComposition = {
  fragments: FragmentStrategy[];
  separator?: string;
};
