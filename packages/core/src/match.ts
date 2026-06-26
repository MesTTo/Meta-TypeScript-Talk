// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Nondeterministic pattern matching and binding-set merge, a faithful port of
// LeaTTa `Core/Matching.lean`. Matching follows the official left/right style.
import { type Atom, atomEq } from "./atom";
import { type Bindings, type BindingRel, lookupVal, addValRaw, addEqRaw } from "./bindings";
import { unifiable } from "./unify";

/** A custom matcher for grounded atoms; may be nondeterministic. */
export type GroundMatcher = (left: Atom, right: Atom) => Bindings[];

/** Add `$x ← v` to `b` consistently (LeaTTa `addVarBinding`). */
export function addVarBinding(b: Bindings, x: string, v: Atom): Bindings[] {
  const prev = lookupVal(b, x);
  if (prev === undefined) return [addValRaw(b, x, v)];
  if (atomEq(prev, v)) return [b];
  return unifiable(prev, v) ? [addValRaw(b, x, v)] : [];
}

/** Add the alias `$x = $y` to `b` consistently (LeaTTa `addVarEquality`). */
export function addVarEquality(b: Bindings, x: string, y: string): Bindings[] {
  const vx = lookupVal(b, x);
  const vy = lookupVal(b, y);
  if (vx !== undefined && vy !== undefined) return atomEq(vx, vy) ? [addEqRaw(b, x, y)] : [];
  return [addEqRaw(b, x, y)];
}

/** Fold one relation into every candidate set, keeping consistent extensions (LeaTTa `mergeOne`). */
function mergeOne(bs: Bindings[], r: BindingRel): Bindings[] {
  const out: Bindings[] = [];
  for (const b of bs) {
    const ext = r.tag === "val" ? addVarBinding(b, r.x, r.a) : addVarEquality(b, r.x, r.y);
    for (const e of ext) out.push(e);
  }
  return out;
}

/** Combine two binding sets into all their consistent unions (LeaTTa `merge`). */
export function merge(a: Bindings, b: Bindings): Bindings[] {
  let acc: Bindings[] = [a];
  for (const r of b) acc = mergeOne(acc, r);
  return acc;
}

/** Match atoms in the official left/right style (LeaTTa `matchAtomsWith`). */
export function matchAtomsWith(custom: GroundMatcher | undefined, l: Atom, r: Atom): Bindings[] {
  if (l.kind === "sym" && r.kind === "sym") return l.name === r.name ? [[]] : [];
  if (l.kind === "var" && r.kind === "var")
    return l.name === r.name ? [[]] : [[{ tag: "val", x: l.name, a: r, y: undefined }]];
  if (l.kind === "var") return [[{ tag: "val", x: l.name, a: r, y: undefined }]];
  if (r.kind === "var") return [[{ tag: "val", x: r.name, a: l, y: undefined }]];
  if (l.kind === "expr" && r.kind === "expr") return matchAll(custom, [[]], l.items, r.items);
  if (l.kind === "gnd") return matchGrounded(custom, l, r);
  if (r.kind === "gnd") return matchGrounded(custom, r, l);
  return atomEq(l, r) ? [[]] : [];
}

function matchGrounded(custom: GroundMatcher | undefined, g: Atom, other: Atom): Bindings[] {
  if (g.kind === "gnd" && g.match !== undefined) return g.match(other) as Bindings[];
  if (custom !== undefined) return custom(g, other);
  return atomEq(g, other) ? [[]] : [];
}

/** Pointwise-match two atom lists, threading the accumulated binding sets (LeaTTa `matchAll`). */
function matchAll(
  custom: GroundMatcher | undefined,
  acc: Bindings[],
  xs: readonly Atom[],
  ys: readonly Atom[],
): Bindings[] {
  if (xs.length !== ys.length) return [];
  let cur = acc;
  for (let i = 0; i < xs.length; i++) {
    const subs = matchAtomsWith(custom, xs[i] as Atom, ys[i] as Atom);
    const next: Bindings[] = [];
    for (const a of cur) for (const b of subs) for (const m of merge(a, b)) next.push(m);
    cur = next;
    if (cur.length === 0) break;
  }
  return cur;
}

/** Match pattern `l` against `r` with the default matcher (no custom grounded matching). */
export function matchAtoms(l: Atom, r: Atom): Bindings[] {
  return matchAtomsWith(undefined, l, r);
}
