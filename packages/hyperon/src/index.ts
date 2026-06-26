// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// @metta-ts/hyperon — an idiomatic TypeScript class API over the @metta-ts/core MeTTa interpreter,
// modeled on Hyperon's `hyperon.atoms` / `hyperon.base`. TypeScript-native (no Python, no Rust, no
// FFI): it wraps the core's immutable atoms in classes. Python method names are kept as aliases next
// to the idiomatic ones so ported Hyperon code reads naturally.
export {
  Atom,
  SymbolAtom,
  VariableAtom,
  ExpressionAtom,
  GroundedAtom,
  GroundedObject,
  ValueObject,
  MatchableObject,
  OperationObject,
  AtomType,
  S,
  V,
  E,
  G,
  ValueAtom,
  OperationAtom,
  groundToJs,
  friendlyTypeName,
  clearGroundedObjects,
  atomIsError,
  atomsAreEquivalent,
  type MetaType,
} from "./atoms";
export { Bindings, BindingsSet } from "./bindings";
export {
  SpaceRef,
  GroundingSpace,
  Tokenizer,
  SExprParser,
  MeTTa,
  IncorrectArgumentError,
  standardTokenizer,
} from "./base";
export { registerJsonModule, SpaceValue } from "./modules/json";
export { registerCatalogModule, ModuleCatalog } from "./modules/catalog";
export { registerJsInterop, JsValue, atomToJs, jsToAtom } from "./modules/js";
