// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { runProgram } from "./runner";
import { format } from "./parser";

const q = (src: string, i = 0): string[] => runProgram(src)[i]!.results.map(format);

describe("runner + stdlib prelude", () => {
  it("stdlib if reduces", () => {
    expect(q("!(if (> 3 2) yes no)")).toEqual(["yes"]);
    expect(q("!(if (< 3 2) yes no)")).toEqual(["no"]);
  });

  it("stdlib let binds", () => {
    expect(q("!(let $x 5 (+ $x 1))")).toEqual(["6"]);
  });

  it("stdlib let* sequences bindings", () => {
    expect(q("!(let* (($x 2) ($y (* $x 3))) (+ $x $y))")).toEqual(["8"]);
  });

  it("arithmetic and comparison through the prelude types", () => {
    expect(q("!(+ 1 2)")).toEqual(["3"]);
    expect(q("!(== 2 2)")).toEqual(["True"]);
  });

  it("sequential: a definition is visible to a later query", () => {
    const src = "(= (f $x) (* $x $x))\n!(f 7)";
    expect(q(src)).toEqual(["49"]);
  });
});
