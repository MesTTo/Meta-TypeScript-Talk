// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { matchAtoms, merge } from "./match";
import { type Bindings, lookupVal } from "./bindings";
import { sym, variable, expr, gint, atomEq, type Atom } from "./atom";
import { applySubst } from "./substitution";
import { bindingsToSubst } from "./instantiate";

const resolves = (bs: Bindings[], v: string, want: Atom): boolean =>
  bs.some((b) => {
    const r = applySubst(bindingsToSubst(b), variable(v));
    return atomEq(r, want);
  });

describe("matchAtoms (verified against LeaTTa Matching.lean)", () => {
  it("equal symbols match once; unequal never", () => {
    expect(matchAtoms(sym("A"), sym("A")).length).toBe(1);
    expect(matchAtoms(sym("A"), sym("B")).length).toBe(0);
  });

  it("a variable on the left binds to the right", () => {
    const r = matchAtoms(variable("x"), sym("A"));
    expect(r.length).toBe(1);
    expect(resolves(r, "x", sym("A"))).toBe(true);
  });

  it("two distinct variables produce a val(x, $y) binding", () => {
    const r = matchAtoms(variable("x"), variable("y"));
    expect(r.length).toBe(1);
    expect(lookupVal(r[0]!, "x")).toEqual(variable("y"));
  });

  it("expressions match element-wise and propagate bindings", () => {
    const r = matchAtoms(expr([sym("p"), variable("x")]), expr([sym("p"), sym("A")]));
    expect(r.length).toBe(1);
    expect(resolves(r, "x", sym("A"))).toBe(true);
  });

  it("cross-argument consistency: $x must agree across positions", () => {
    expect(
      matchAtoms(expr([variable("x"), variable("x")]), expr([sym("A"), sym("A")])).length,
    ).toBe(1);
    expect(
      matchAtoms(expr([variable("x"), variable("x")]), expr([sym("A"), sym("B")])).length,
    ).toBe(0);
  });

  it("nested variable agreement (LeaTTa differential cases)", () => {
    expect(
      matchAtoms(expr([variable("x"), expr([variable("x")])]), expr([sym("A"), expr([sym("A")])]))
        .length,
    ).toBe(1);
    expect(
      matchAtoms(expr([variable("x"), expr([variable("x")])]), expr([sym("A"), expr([sym("B")])]))
        .length,
    ).toBe(0);
  });

  it("grounded atoms match by value when no custom matcher", () => {
    expect(matchAtoms(gint(1), gint(1)).length).toBe(1);
    expect(matchAtoms(gint(1), gint(2)).length).toBe(0);
  });

  it("length mismatch does not match", () => {
    expect(matchAtoms(expr([sym("a")]), expr([sym("a"), sym("b")])).length).toBe(0);
  });

  it("merge of conflicting value bindings yields nothing", () => {
    const b1: Bindings = [{ tag: "val", x: "x", a: sym("A"), y: undefined }];
    const b2: Bindings = [{ tag: "val", x: "x", a: sym("B"), y: undefined }];
    expect(merge(b1, b2).length).toBe(0);
  });
});
