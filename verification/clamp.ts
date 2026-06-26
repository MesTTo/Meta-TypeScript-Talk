// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Smoke test of the LemmaScript toolchain in this repo.
export function clamp(x: number, lo: number, hi: number): number {
  //@ verify
  //@ requires lo <= hi
  //@ ensures lo <= \result && \result <= hi
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
