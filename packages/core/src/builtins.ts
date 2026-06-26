// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The grounding table: built-in operations dispatched by symbol name, a faithful port of
// LeaTTa `Core/Builtins.lean`. Each op takes already-evaluated argument atoms and returns a
// ReduceResult. Numbers track int vs float; arithmetic on two ints stays int.
import {
  type Atom,
  type Ground,
  sym,
  gint,
  gfloat,
  gbool,
  gstr,
  emptyExpr,
  expr,
  atomEq,
  atomSize,
  isErrorAtom,
} from "./atom";
import { alphaEq } from "./alpha";
import { format } from "./parser";

export type ReduceResult =
  | { readonly tag: "ok"; readonly results: readonly Atom[] }
  | { readonly tag: "runtimeError"; readonly msg: string }
  | { readonly tag: "incorrectArgument"; readonly msg: string }
  | { readonly tag: "noReduce" };

export type GroundFn = (args: readonly Atom[]) => ReduceResult;
export type GroundingTable = Map<string, GroundFn>;

const ok = (...results: Atom[]): ReduceResult => ({ tag: "ok", results });
const rerr = (msg: string): ReduceResult => ({ tag: "runtimeError", msg });
const ierr = (msg: string): ReduceResult => ({ tag: "incorrectArgument", msg });

// Output sink for println!/trace! — overridable so embedders and tests can capture output instead of
// writing to the console.
let outputSink: (line: string) => void = (line) => {
  console.log(line);
};
/** Replace the line-output sink used by `println!`/`trace!` (returns the previous sink). */
export function setOutputSink(fn: (line: string) => void): (line: string) => void {
  const prev = outputSink;
  outputSink = fn;
  return prev;
}

/** Display form of an atom for printing: a top-level string shows unquoted; everything else uses the
 *  standard MeTTa rendering. */
function display(a: Atom): string {
  if (a.kind === "gnd" && a.value.g === "str") return a.value.s;
  return format(a);
}

// --- numeric coercions ---
interface Num {
  readonly float: boolean;
  readonly n: number;
}
function asNum(a: Atom): Num | undefined {
  if (a.kind !== "gnd") return undefined;
  const v: Ground = a.value;
  if (v.g === "int") return { float: false, n: v.n };
  if (v.g === "float") return { float: true, n: v.n };
  return undefined;
}
function asInt(a: Atom): number | undefined {
  if (a.kind === "gnd" && a.value.g === "int") return a.value.n;
  return undefined;
}
function asBool(a: Atom): boolean | undefined {
  if (a.kind === "gnd" && a.value.g === "bool") return a.value.b;
  return undefined;
}
function asFloat(a: Atom): number | undefined {
  const n = asNum(a);
  return n?.n;
}

const numResult = (float: boolean, n: number): Atom => (float ? gfloat(n) : gint(n));

function numBin(f: (x: number, y: number) => number): GroundFn {
  return (args) => {
    if (args.length !== 2) return ierr("expected exactly two arguments");
    const x = asNum(args[0]!);
    const y = asNum(args[1]!);
    if (x === undefined || y === undefined) return ierr("expected two Numbers");
    return ok(numResult(x.float || y.float, f(x.n, y.n)));
  };
}
function numCmp(f: (x: number, y: number) => boolean): GroundFn {
  return (args) => {
    if (args.length !== 2) return ierr("expected exactly two arguments");
    const x = asNum(args[0]!);
    const y = asNum(args[1]!);
    if (x === undefined || y === undefined) return ierr("expected two Numbers");
    return ok(gbool(f(x.n, y.n)));
  };
}
function boolBin(f: (x: boolean, y: boolean) => boolean): GroundFn {
  return (args) => {
    if (args.length !== 2) return ierr("expected exactly two arguments");
    const x = asBool(args[0]!);
    const y = asBool(args[1]!);
    if (x === undefined || y === undefined) return ierr("expected two Bool atoms");
    return ok(gbool(f(x, y)));
  };
}

// `==`: error operands pass through; otherwise structural equality as a Bool.
const eqAtom: GroundFn = (args) => {
  if (args.length !== 2) return ierr("expected exactly two arguments");
  const a = args[0]!;
  const b = args[1]!;
  if (isErrorAtom(a)) return ok(a);
  if (isErrorAtom(b)) return ok(b);
  return ok(gbool(atomEq(a, b)));
};

// --- list surgery ---
const consAtom: GroundFn = (args) => {
  if (args.length !== 2) return ierr("expected head and tail");
  const [h, t] = args as [Atom, Atom];
  return t.kind === "expr" ? ok(expr([h, ...t.items])) : ok(expr([h, t]));
};
const deconsAtom: GroundFn = (args) => {
  if (args.length !== 1) return ierr("expected non-empty expression");
  const e = args[0]!;
  if (e.kind !== "expr") return ierr("expected non-empty expression");
  if (e.items.length === 0) return ok(emptyExpr);
  const [h, ...t] = e.items;
  return ok(expr([h!, expr(t)]));
};
const carAtom: GroundFn = (args) => {
  const e = args[0];
  if (args.length !== 1 || e?.kind !== "expr" || e.items.length === 0)
    return ierr("expected non-empty expression");
  return ok(e.items[0]!);
};
const cdrAtom: GroundFn = (args) => {
  const e = args[0];
  if (args.length !== 1 || e?.kind !== "expr" || e.items.length === 0)
    return ierr("expected non-empty expression");
  return ok(expr(e.items.slice(1)));
};
const sizeAtom: GroundFn = (args) => {
  if (args.length !== 1) return ierr("expected one atom");
  const a = args[0]!;
  return ok(gint(a.kind === "expr" ? a.items.length : atomSize(a)));
};
const minMaxAtom =
  (isMin: boolean, name: string): GroundFn =>
  (args) => {
    const e = args[0];
    if (args.length !== 1 || e?.kind !== "expr")
      return ierr(name + " expects one argument: expression");
    const nums: number[] = [];
    for (const c of e.items) {
      const f = asFloat(c);
      if (f === undefined) return rerr("Only numbers are allowed in expression");
      nums.push(f);
    }
    if (nums.length === 0) return rerr("Empty expression");
    let acc = nums[0]!;
    for (const z of nums.slice(1)) acc = isMin ? (z < acc ? z : acc) : z > acc ? z : acc;
    return ok(gfloat(acc));
  };
const indexAtom: GroundFn = (args) => {
  const e = args[0];
  if (args.length !== 2 || e?.kind !== "expr")
    return ierr("index-atom expects two arguments: expression and atom");
  const i = asInt(args[1]!);
  if (i === undefined) return ierr("index-atom expects two arguments: expression and atom");
  if (i < 0 || i >= e.items.length) return rerr("Index is out of bounds");
  return ok(e.items[i]!);
};

// --- f64 math ---
const floatUn =
  (ff: (x: number) => number): GroundFn =>
  (args) => {
    if (args.length !== 1) return ierr("expected exactly one argument");
    const x = asFloat(args[0]!);
    return x === undefined ? ierr("expected a Number") : ok(gfloat(ff(x)));
  };
const floatBin =
  (ff: (x: number, y: number) => number): GroundFn =>
  (args) => {
    if (args.length !== 2) return ierr("expected exactly two arguments");
    const x = asFloat(args[0]!);
    const y = asFloat(args[1]!);
    return x === undefined || y === undefined ? ierr("expected two Numbers") : ok(gfloat(ff(x, y)));
  };
const numRound =
  (fi: (n: number) => number, ff: (x: number) => number): GroundFn =>
  (args) => {
    if (args.length !== 1) return ierr("expected exactly one argument");
    const a = args[0]!;
    if (a.kind === "gnd" && a.value.g === "int") return ok(gint(fi(a.value.n)));
    if (a.kind === "gnd" && a.value.g === "float") return ok(gfloat(ff(a.value.n)));
    return ierr("expected a Number");
  };
const floatPred =
  (fb: (x: number) => boolean): GroundFn =>
  (args) => {
    if (args.length !== 1) return ierr("expected exactly one argument");
    const a = args[0]!;
    if (a.kind === "gnd" && a.value.g === "int") return ok(gbool(false));
    if (a.kind === "gnd" && a.value.g === "float") return ok(gbool(fb(a.value.n)));
    return ierr("expected a Number");
  };

const mathEntries: Array<[string, GroundFn]> = [
  ["sqrt-math", floatUn(Math.sqrt)],
  ["sin-math", floatUn(Math.sin)],
  ["cos-math", floatUn(Math.cos)],
  ["tan-math", floatUn(Math.tan)],
  ["asin-math", floatUn(Math.asin)],
  ["acos-math", floatUn(Math.acos)],
  ["atan-math", floatUn(Math.atan)],
  ["pow-math", floatBin(Math.pow)],
  ["log-math", floatBin((base, input) => Math.log(input) / Math.log(base))],
  ["abs-math", numRound((n) => Math.abs(n), Math.abs)],
  ["trunc-math", numRound((n) => n, Math.trunc)],
  ["ceil-math", numRound((n) => n, Math.ceil)],
  ["floor-math", numRound((n) => n, Math.floor)],
  ["round-math", numRound((n) => n, Math.round)],
  ["isnan-math", floatPred(Number.isNaN)],
  ["isinf-math", floatPred((x) => !Number.isFinite(x) && !Number.isNaN(x))],
];

const coreEntries: Array<[string, GroundFn]> = [
  ["+", numBin((a, b) => a + b)],
  ["-", numBin((a, b) => a - b)],
  ["*", numBin((a, b) => a * b)],
  ["<", numCmp((a, b) => a < b)],
  ["<=", numCmp((a, b) => a <= b)],
  [">", numCmp((a, b) => a > b)],
  [">=", numCmp((a, b) => a >= b)],
  ["==", eqAtom],
  ["and", boolBin((a, b) => a && b)],
  ["or", boolBin((a, b) => a || b)],
  ["cons-atom", consAtom],
  ["decons-atom", deconsAtom],
  ["car-atom", carAtom],
  ["cdr-atom", cdrAtom],
  ["size-atom", sizeAtom],
  ["min-atom", minMaxAtom(true, "min-atom")],
  ["max-atom", minMaxAtom(false, "max-atom")],
  ["index-atom", indexAtom],
];

// --- stdlib grounded ops (LeaTTa Stdlib.lean stdGroundings) ---
const removeFirst = (a: Atom, xs: readonly Atom[]): Atom[] => {
  const i = xs.findIndex((x) => atomEq(x, a));
  return i < 0 ? [...xs] : [...xs.slice(0, i), ...xs.slice(i + 1)];
};
const dedupAlpha = (xs: readonly Atom[]): Atom[] => {
  const out: Atom[] = [];
  for (const x of xs) if (!out.some((s) => alphaEq(s, x))) out.push(x);
  return out;
};
const msIntersect = (lhs: readonly Atom[], rhs: readonly Atom[]): Atom[] => {
  let pool = [...rhs];
  const out: Atom[] = [];
  for (const x of lhs)
    if (pool.some((y) => atomEq(y, x))) {
      out.push(x);
      pool = removeFirst(x, pool);
    }
  return out;
};
const msSubtract = (lhs: readonly Atom[], rhs: readonly Atom[]): Atom[] => {
  let pool = [...rhs];
  const out: Atom[] = [];
  for (const x of lhs) {
    if (pool.some((y) => atomEq(y, x))) pool = removeFirst(x, pool);
    else out.push(x);
  }
  return out;
};
const resultItems = (xs: readonly Atom[]): Atom[] =>
  xs.length > 0 && xs[0]!.kind === "sym" && xs[0]!.name === "," ? xs.slice(1) : [...xs];
const removeFirstBy = (
  eq: (a: Atom, b: Atom) => boolean,
  a: Atom,
  xs: readonly Atom[],
): Atom[] | undefined => {
  const i = xs.findIndex((x) => eq(a, x));
  return i < 0 ? undefined : [...xs.slice(0, i), ...xs.slice(i + 1)];
};
const bagEqBy = (
  eq: (a: Atom, b: Atom) => boolean,
  as: readonly Atom[],
  bs: readonly Atom[],
): boolean => {
  let pool: Atom[] = [...bs];
  for (const a of as) {
    const r = removeFirstBy(eq, a, pool);
    if (r === undefined) return false;
    pool = r;
  }
  return pool.length === 0;
};
const exprArgs = (args: readonly Atom[]): Atom[][] | undefined => {
  const out: Atom[][] = [];
  for (const a of args) {
    if (a.kind !== "expr") return undefined;
    out.push([...a.items]);
  }
  return out;
};

const getMetatypeOp: GroundFn = (args) => {
  const a = args[0];
  if (args.length !== 1 || a === undefined) return ierr("get-metatype expects 1 argument");
  const k =
    a.kind === "sym"
      ? "Symbol"
      : a.kind === "var"
        ? "Variable"
        : a.kind === "expr"
          ? "Expression"
          : "Grounded";
  return ok(sym(k));
};
const assertEqOp =
  (eq: (a: Atom, b: Atom) => boolean): GroundFn =>
  (args) => {
    if (args.length !== 3 && args.length !== 4) return ierr("_assert-results-are-equal arity");
    const a0 = args[0];
    const e0 = args[1];
    if (a0?.kind !== "expr" || e0?.kind !== "expr") return ierr("expected two expressions");
    const okEq = bagEqBy(eq, resultItems(a0.items), resultItems(e0.items));
    if (okEq) return ok(emptyExpr);
    const msg = args.length === 4 ? args[3]! : sym("results-are-not-equal");
    return ok(expr([sym("Error"), args[2]!, msg]));
  };
const sortByFormat = (xs: readonly Atom[]): Atom[] =>
  [...xs].sort((a, b) => (format(a) < format(b) ? -1 : format(a) > format(b) ? 1 : 0));

const stdEntries: Array<[string, GroundFn]> = [
  [
    "println!",
    (args) => {
      if (args.length !== 1) return ierr("println! expects 1 argument");
      outputSink(display(args[0]!));
      return ok(emptyExpr);
    },
  ],
  [
    "print!",
    (args) => {
      if (args.length !== 1) return ierr("print! expects 1 argument");
      outputSink(display(args[0]!));
      return ok(emptyExpr);
    },
  ],
  [
    "format-args",
    (args) => {
      if (args.length !== 2) return ierr("format-args expects 2 arguments");
      const tmpl = args[0]!;
      const items = args[1]!;
      if (tmpl.kind !== "gnd" || tmpl.value.g !== "str")
        return ierr("format-args: first argument must be a String");
      if (items.kind !== "expr") return ierr("format-args: second argument must be an Expression");
      let i = 0;
      const out = tmpl.value.s.replace(/\{\}/g, () => {
        const it = items.items[i++];
        return it === undefined ? "{}" : display(it);
      });
      return ok(gstr(out));
    },
  ],
  [
    "repr",
    (args) => (args.length === 1 ? ok(gstr(format(args[0]!))) : ierr("repr expects 1 argument")),
  ],
  [
    "if-equal",
    (args) =>
      args.length === 4
        ? ok(alphaEq(args[0]!, args[1]!) ? args[2]! : args[3]!)
        : ierr("if-equal expects 4 arguments"),
  ],
  [
    "=alpha",
    (args) =>
      args.length === 2
        ? ok(gbool(alphaEq(args[0]!, args[1]!)))
        : ierr("=alpha expects 2 arguments"),
  ],
  ["get-metatype", getMetatypeOp],
  [
    "not",
    (args) => {
      const b = asBool(args[0]!);
      return args.length === 1 && b !== undefined ? ok(gbool(!b)) : ierr("not expects one Bool");
    },
  ],
  [
    "xor",
    (args) => {
      const x = asBool(args[0]!);
      const y = asBool(args[1]!);
      return args.length === 2 && x !== undefined && y !== undefined
        ? ok(gbool(x !== y))
        : ierr("xor expects two Bool");
    },
  ],
  [
    "/",
    (args) => {
      if (args.length === 2) {
        const a = args[0]!;
        const b = args[1]!;
        if (a.kind === "gnd" && a.value.g === "int" && b.kind === "gnd" && b.value.g === "int")
          return b.value.n === 0
            ? rerr("DivisionByZero")
            : ok(gint(Math.trunc(a.value.n / b.value.n)));
      }
      return numBin((x, y) => x / y)(args);
    },
  ],
  [
    "%",
    (args) => {
      const a = args[0];
      const b = args[1];
      if (
        args.length === 2 &&
        a?.kind === "gnd" &&
        a.value.g === "int" &&
        b?.kind === "gnd" &&
        b.value.g === "int"
      )
        return b.value.n === 0 ? rerr("DivisionByZero") : ok(gint(a.value.n % b.value.n));
      return ierr("% expects two Int atoms");
    },
  ],
  [
    "unique-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(expr(dedupAlpha(e[0]!)))
        : ierr("unique-atom expects one expression");
    },
  ],
  [
    "union-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 2
        ? ok(expr([...e[0]!, ...e[1]!]))
        : ierr("union-atom expects two expressions");
    },
  ],
  [
    "intersection-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 2
        ? ok(expr(msIntersect(e[0]!, e[1]!)))
        : ierr("intersection-atom expects two expressions");
    },
  ],
  [
    "subtraction-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 2
        ? ok(expr(msSubtract(e[0]!, e[1]!)))
        : ierr("subtraction-atom expects two expressions");
    },
  ],
  [
    "superpose",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(...resultItems(e[0]!))
        : ierr("superpose expects one expression");
    },
  ],
  [
    "hyperpose",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(...resultItems(e[0]!))
        : ierr("hyperpose expects one expression");
    },
  ],
  [
    "collapse-extract",
    (args) => {
      const e = exprArgs(args);
      if (!e || e.length !== 1) return ierr("collapse-extract expects one expression");
      return ok(
        expr([
          sym(","),
          ...e[0]!.map((p) => (p.kind === "expr" && p.items.length > 0 ? p.items[0]! : p)),
        ]),
      );
    },
  ],
  [
    "sealed",
    (args) => (args.length === 2 ? ok(args[1]!) : ierr("sealed expects (sealed <vars> <atom>)")),
  ],
  ["nop", () => ok(emptyExpr)],
  ["pragma!", () => ok(emptyExpr)],
  ["register-module!", () => ok(emptyExpr)],
  ["help!", () => ok(emptyExpr)],
  ["empty", () => ok()],
  ["_assert-results-are-equal", assertEqOp(atomEq)],
  ["_assert-results-are-equal-msg", assertEqOp(atomEq)],
  ["_assert-results-are-alpha-equal", assertEqOp(alphaEq)],
  ["_assert-results-are-alpha-equal-msg", assertEqOp(alphaEq)],
  [
    "sort-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(expr(sortByFormat(e[0]!)))
        : ierr("sort-atom expects one expression");
    },
  ],
  [
    "sort-strings",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(expr(sortByFormat(e[0]!)))
        : ierr("sort-strings expects one expression");
    },
  ],
];

/** The arithmetic / boolean / list-surgery / math grounding core every KB starts with. */
export function baseTable(): GroundingTable {
  return new Map<string, GroundFn>([...mathEntries, ...coreEntries]);
}

/** The full standard-library grounding table (base + stdlib grounded ops). */
export function stdTable(): GroundingTable {
  return new Map<string, GroundFn>([...mathEntries, ...coreEntries, ...stdEntries]);
}

/** Dispatch `op` through the grounding table, or `noReduce` if unknown. */
export function callGrounded(gt: GroundingTable, op: string, args: readonly Atom[]): ReduceResult {
  const fn = gt.get(op);
  return fn ? fn(args) : { tag: "noReduce" };
}
