// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Function-free model of MeTTa terms, used to verify the structural invariants that the real
// unify.ts / substitution.ts depend on. (The real `Atom` carries function-valued grounded fields,
// outside LemmaScript's subset, so the structural core is verified on this faithful model.)
export type Term =
  | { tag: "leaf" }
  | { tag: "var"; name: string }
  | { tag: "node"; kids: Term[] };

// Term size. unify.ts's `unifyTop` uses `atomSize(a) + atomSize(b)` as its fuel/termination
// measure; this proves the measure is always positive (so the fuel is well-founded).
export function termSize(t: Term): number {
  //@ verify
  //@ ensures \result >= 1
  if (t.tag === "node") {
    let n = 1;
    let i = 0;
    while (i < t.kids.length) {
      //@ invariant 1 <= n
      //@ invariant 0 <= i && i <= t.kids.length
      //@ decreases t.kids.length - i
      n = n + termSize(t.kids[i]);
      i = i + 1;
    }
    return n;
  }
  return 1;
}
