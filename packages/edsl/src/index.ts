// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// @metta-ts/edsl — an ergonomic, typed TypeScript eDSL for MeTTa. Typed term builders and special-form
// combinators construct ordinary atoms; a tagged-template surface (`m`) handles everything else; and
// `mettaDB()` runs them on the existing interpreter. Any TypeScript value can be dropped in as a grounded
// atom via `ground` (or by interpolation in a template).
export {
  type Term,
  type Var,
  type VarValue,
  type SymbolBuilder,
  v,
  S,
  ground,
  e,
  rel,
  nil,
  list,
} from "./term";
export {
  rule,
  decl,
  arrow,
  iff,
  caseOf,
  lett,
  letStar,
  matchSelf,
  superpose,
  collapse,
  empty,
  unify,
  add,
  sub,
  mul,
  div,
  mod,
  eq,
  gt,
  lt,
  ge,
  le,
  and,
  or,
  not,
  carAtom,
  cdrAtom,
  consAtom,
} from "./forms";
export { m, mAll } from "./template";
export { MettaDB, mettaDB, type Row } from "./db";

// Re-export the hyperon atom types so consumers can annotate without a second import.
export { Atom, type GroundedAtom, ValueAtom, atomToJs } from "@metta-ts/hyperon";
