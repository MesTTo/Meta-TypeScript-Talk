// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Applying a binding set as a substitution (LeaTTa `bindingsToSubst` / `instantiate`).
import { type Atom } from "./atom";
import { type Bindings } from "./bindings";
import { type Subst, applySubst } from "./substitution";

/** A binding set viewed as a substitution: value bindings only; `eq` aliases are dropped. */
export function bindingsToSubst(b: Bindings): Subst {
  const out: Array<readonly [string, Atom]> = [];
  for (const r of b) if (r.tag === "val") out.push([r.x, r.a]);
  return out;
}

/** Apply a binding set to an atom (value bindings only). */
export function instantiate(b: Bindings, a: Atom): Atom {
  return applySubst(bindingsToSubst(b), a);
}
