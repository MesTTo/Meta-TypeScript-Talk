// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// TS-native MeTTa extensions — NOT part of upstream MeTTa — packaged as importable built-in modules.
// They stay out of the vendored, spec-conformant prelude so the 270/270 Hyperon oracle runs against a
// pristine baseline; a program opts in with `(import! &self concurrency)`. Importing a module brings
// its type signatures into scope (see `registerImportedTypes` in eval.ts), which is what makes the
// type-directed argument handling work — e.g. `transaction`'s body is typed `Atom`, so it reaches the
// transaction instruction unevaluated and is evaluated under snapshot/rollback.
import { type Atom } from "./atom";
import { parseAll } from "./parser";
import { standardTokenizer } from "./runner";

/** The `concurrency` module: timing/concurrency extensions (transaction, and later par/race/mutex). */
export const CONCURRENCY_MODULE_SRC = `
  (: transaction (-> Atom %Undefined%))
`;

const moduleCache = new Map<string, Atom[]>();

function parseModule(src: string): Atom[] {
  return parseAll(src, standardTokenizer())
    .filter((t) => !t.bang)
    .map((t) => t.atom);
}

/** The built-in extension modules, by the name used in `(import! &self <name>)`. */
export function builtinModules(): Map<string, Atom[]> {
  if (moduleCache.size === 0) {
    moduleCache.set("concurrency", parseModule(CONCURRENCY_MODULE_SRC));
  }
  return moduleCache;
}

/** A fresh imports map seeded with the built-in extension modules, optionally merged with caller
 *  imports. Built-ins are only applied when a program actually `(import! ...)`s them, so this never
 *  affects the Hyperon oracle baseline. */
export function withBuiltinModules(extra?: Map<string, Atom[]>): Map<string, Atom[]> {
  const out = new Map<string, Atom[]>(builtinModules());
  if (extra) for (const [k, v] of extra) out.set(k, v);
  return out;
}
