// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { buildEnv, evalAtom } from "./eval";
import { baseTable } from "./builtins";
import { parseAll } from "./parser";
import { format } from "./parser";
import { Tokenizer } from "./tokenizer";
import { gint, gfloat, gbool } from "./atom";

const tk = (): Tokenizer => {
  const t = new Tokenizer();
  t.register(/^-?\d+$/, (s) => gint(Number(s)));
  t.register(/^-?\d+\.\d+$/, (s) => gfloat(Number(s)));
  t.register(/^True$/, () => gbool(true));
  t.register(/^False$/, () => gbool(false));
  return t;
};

// Evaluate `!`-expressions in `src`; non-bang atoms form the KB.
function run(src: string): string[][] {
  const t = tk();
  const tops = parseAll(src, t);
  const kb = tops.filter((x) => !x.bang).map((x) => x.atom);
  const env = buildEnv(kb, baseTable());
  return tops.filter((x) => x.bang).map((x) => evalAtom(env, x.atom)[0]!.map(format));
}
const first = (r: string[][]): string[] => r[0]!;

describe("evaluator (smoke)", () => {
  it("reduces grounded arithmetic", () => {
    expect(first(run("!(+ 1 2)"))).toEqual(["3"]);
    expect(first(run("!(* 2 (+ 3 4))"))).toEqual(["14"]);
  });

  it("keeps int and float distinct", () => {
    expect(first(run("!(+ 1.0 2.0)"))).toEqual(["3.0"]);
  });

  it("applies a user-defined function rule", () => {
    expect(first(run("(= (double $x) (* 2 $x))\n!(double 21)"))).toEqual(["42"]);
  });

  it("recursion with freshening (unify-guarded factorial)", () => {
    const src = `
      (: unify (-> Atom Atom Atom Atom %Undefined%))
      (= (fact $n) (unify $n 0 1 (* $n (fact (- $n 1)))))
      !(fact 5)`;
    expect(first(run(src))).toEqual(["120"]);
  });

  it("if via unify reduces correctly", () => {
    const src = `
      (: unify (-> Atom Atom Atom Atom %Undefined%))
      (= (ift $c $t $e) (unify $c True $t $e))
      !(ift (> 3 2) yes no)`;
    expect(first(run(src))).toEqual(["yes"]);
  });

  it("nondeterminism: a relation with two facts yields two results", () => {
    const src = `
      (= (color) red)
      (= (color) blue)
      !(color)`;
    expect(first(run(src)).sort()).toEqual(["blue", "red"]);
  });
});
