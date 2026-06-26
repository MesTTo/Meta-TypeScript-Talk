// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Verified model of the bindings lookup the matcher relies on (bindings.ts `lookupVal`):
// the first value bound to a key, proven to be a value actually present for that key.
export type Pair = { key: string; val: number };

export function lookupFirst(b: Pair[], x: string): number {
  //@ verify
  //@ requires exists(k: nat, k < b.length && b[k].key === x)
  //@ ensures exists(k: nat, k < b.length && b[k].key === x && b[k].val === \result)
  //@ type i nat
  let i = 0;
  while (i < b.length) {
    //@ invariant 0 <= i && i <= b.length
    //@ invariant forall(j: nat, j < i ==> b[j].key !== x)
    //@ decreases b.length - i
    if (b[i].key === x) return b[i].val;
    i = i + 1;
  }
  return 0;
}
