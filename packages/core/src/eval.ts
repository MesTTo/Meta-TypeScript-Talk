// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The minimal MeTTa interpreter and type-directed evaluator: a faithful port of LeaTTa
// `MettaHyperonFull/Minimal/Interpreter.lean` (itself a port of Hyperon `interpreter.rs`).
// A CPS nondeterministic stack machine over the minimal instructions, with `mettaEval` (the
// type-directed metta-call loop) on top. The driver is iterative to keep the JS stack shallow.
import { type Atom, sym, variable, expr, gint, atomEq, atomVars, emptyExpr, isErrorAtom } from "./atom";
import { type Bindings, type BindingRel, hasLoop } from "./bindings";
import { matchAtoms, merge } from "./match";
import { instantiate } from "./instantiate";
import { type Subst, applySubst } from "./substitution";
import { type GroundingTable, type ReduceResult, callGrounded } from "./builtins";

// ---------- generator-based evaluation (sync core, optional async) ----------
// The driver functions are generators that `yield` a pending Promise only at the one async boundary
// (an async grounded operation). A sync driver runs a generator to completion and throws if it ever
// actually suspends; an async driver awaits the yielded Promises. One implementation, two drivers
// (the gensync / Effect pattern) — so the synchronous path is unchanged in behaviour, and async is
// purely additive. `yield*` propagates a suspension up through the whole nested call chain.
/** A grounded operation that runs asynchronously, for the async runner. */
export type AsyncGroundFn = (args: readonly Atom[]) => Promise<ReduceResult>;
// A suspension is any Promise the async driver awaits; each yield site knows its resolved type. The
// grounded boundary yields a Promise<ReduceResult>; the concurrency primitives yield Promise<[pairs,St]>.
type Susp = Promise<unknown>;
type Gen<R> = Generator<Susp, R, unknown>;
type EvalRes = [Array<[Atom, Bindings]>, St];

// TS-native concurrency primitives (async-only): par/race evaluate their argument expressions
// concurrently; with-mutex serialises a critical section across await points. Their arguments are NOT
// eagerly evaluated (the op drives them), and reaching them in the sync driver throws AsyncInSyncError.
const LAZY_ARGS_OPS = new Set(["par", "race", "once", "with-mutex"]);
const MUTEXES = new Map<string, Promise<void>>();

/** Thrown when synchronous evaluation reaches an async grounded operation. Use the async runner. */
export class AsyncInSyncError extends Error {
  constructor(op: string) {
    super(`async grounded operation '${op}' reached in synchronous evaluation; use the async runner`);
    this.name = "AsyncInSyncError";
  }
}

let pendingAsyncOp = "?";
function runGenSync<R>(gen: Gen<R>): R {
  const r = gen.next();
  if (!r.done) throw new AsyncInSyncError(pendingAsyncOp);
  return r.value;
}
/** Drive a generator asynchronously, awaiting each yielded Promise. An optional `signal` makes the
 *  evaluation cancellable: it is checked at every suspension point, so a losing `race` branch stops at
 *  its next await (cooperative cancellation — JS cannot preempt a running synchronous computation). */
async function runGenAsync<R>(gen: Gen<R>, signal?: AbortSignal): Promise<R> {
  let r = gen.next();
  while (!r.done) {
    signal?.throwIfAborted();
    const v = await r.value;
    signal?.throwIfAborted();
    r = gen.next(v);
  }
  return r.value;
}

/** The grounded-operation boundary: a sync op returns immediately; an async op (in `env.agt`) yields its
 *  Promise, which the async driver awaits and the sync driver rejects. */
function* callGroundedG(env: MinEnv, op: string, args: readonly Atom[]): Gen<ReduceResult> {
  const af = env.agt.get(op);
  if (af !== undefined) {
    pendingAsyncOp = op;
    return (yield af(args)) as ReduceResult;
  }
  return callGrounded(env.gt, op, args);
}

// ---------- machine types ----------
export type Ret = "none" | "chain" | "function";
export interface Frame {
  readonly atom: Atom;
  readonly ret: Ret;
  readonly vars: readonly string[];
  readonly fin: boolean;
}
// The evaluation stack as an immutable cons-list (O(1) push/rest, no per-step array slice/spread
// — the array form showed up as ArrayPrototypeSlice in the profile). `null` is the empty stack.
export interface StackCons {
  readonly head: Frame;
  readonly tail: Stack;
}
export type Stack = StackCons | null;
const cons = (head: Frame, tail: Stack): StackCons => ({ head, tail });
export interface Item {
  readonly stack: Stack;
  readonly bnd: Bindings;
}
const frame = (
  atom: Atom,
  ret: Ret = "none",
  vars: readonly string[] = [],
  fin = false,
): Frame => ({
  atom,
  ret,
  vars,
  fin,
});

const notReducibleA = sym("NotReducible");
const emptyA = sym("Empty");
const unitA = emptyExpr;
const errAtom = (a: Atom, msg: string): Atom => expr([sym("Error"), a, sym(msg)]);

// ---------- atom destructuring helpers ----------
function opOf(a: Atom): string | undefined {
  return a.kind === "expr" && a.items.length > 0 && a.items[0]!.kind === "sym"
    ? (a.items[0] as { name: string }).name
    : undefined;
}
const EMBEDDED = new Set([
  "eval",
  "evalc",
  "chain",
  "unify",
  "cons-atom",
  "decons-atom",
  "function",
  "collapse-bind",
  "superpose-bind",
  "metta",
  "metta-thread",
  "capture",
  "context-space",
  "match",
  "get-type",
  "get-type-space",
  "get-doc",
  "new-state",
  "get-state",
  "change-state!",
  "new-space",
  "new-mork-space",
  "fork-space",
  "add-atom",
  "remove-atom",
  "get-atoms",
  "bind!",
  "import!",
  // TS-native extension (not upstream MeTTa): atomic space mutation with rollback.
  "transaction",
  // TS-native concurrency primitives (async-only); see docs/.../concurrency-primitives.md.
  "par",
  "race",
  "once",
  "with-mutex",
]);
function isEmbeddedOp(a: Atom): boolean {
  const op = opOf(a);
  return op !== undefined && EMBEDDED.has(op);
}

const varsCopy = (prev: Stack): readonly string[] => (prev !== null ? prev.head.vars : []);

function isVariableHeaded(a: Atom): boolean {
  if (a.kind === "var") return true;
  if (a.kind === "expr" && a.items.length > 0) return isVariableHeaded(a.items[0]!);
  return false;
}

function headKey(a: Atom): string | undefined {
  if (a.kind === "sym") return a.name;
  if (a.kind === "expr" && a.items.length > 0 && a.items[0]!.kind === "sym")
    return (a.items[0] as { name: string }).name;
  return undefined;
}

// ---------- atom_to_stack ----------
function atomToStack(a: Atom, prev: Stack): Stack {
  if (a.kind === "expr") {
    const op = opOf(a);
    const it = a.items;
    if (op === "chain" && it.length === 4 && it[2]!.kind === "var") {
      return atomToStack(it[1]!, cons(frame(a, "chain", varsCopy(prev)), prev));
    }
    if (op === "function" && it.length === 2 && it[1]!.kind === "expr") {
      return atomToStack(it[1]!, cons(frame(a, "function", varsCopy(prev)), prev));
    }
    if (op === "unify" && it.length === 5) {
      return cons(frame(a, "none"), prev);
    }
    if (op === "chain") return cons(frame(errAtom(a, "chain: malformed"), "none", [], true), prev);
    if (op === "function")
      return cons(frame(errAtom(a, "function: malformed"), "none", [], true), prev);
    if (op === "unify") return cons(frame(errAtom(a, "unify: malformed"), "none", [], true), prev);
  }
  return cons(frame(a, "none", varsCopy(prev)), prev);
}

function finItem(st: Stack, a: Atom, b: Bindings): Item {
  return { stack: cons(frame(a, "none", [], true), st), bnd: b };
}

function evalResult(prev: Stack, r: Atom, b: Bindings): Item {
  if (opOf(r) === "function") return { stack: atomToStack(r, prev), bnd: b };
  return finItem(prev, r, b);
}

// ---------- env (MinEnv) ----------
export interface MinEnv {
  ruleIndex: Map<string, Array<[Atom, Atom]>>;
  varRules: Array<[Atom, Atom]>;
  sigs: Map<string, Atom[]>;
  gt: GroundingTable;
  atoms: Atom[];
  types: Map<string, Atom[]>;
  imports: Map<string, Atom[]>;
  exprTypes: Array<[Atom, Atom]>;
  /** Async grounded operations, dispatched by the async runner; empty for pure synchronous evaluation. */
  agt: Map<string, AsyncGroundFn>;
  // Clause indexing over &self atoms, so `match` scales past a linear scan (Prolog-style clause indexing).
  // `factIndex` maps an atom's head key (functor for an expression, name for a symbol) to its atoms —
  // used for variable/expression first-argument queries. `firstArgIndex` is the finer index, keyed by
  // `functor + arg key` for atoms whose first argument is a ground leaf (symbol or grounded value), so
  // a query like `(edge 500000 $y)` jumps straight to the matching row even when a million atoms share
  // the `edge` functor. `functorVarFirst` holds atoms of a functor whose first argument is NOT a
  // ground leaf (a variable or expression), which must be considered for any first-argument query of
  // that functor. `varHeadedFacts` holds atoms with no head key (variable-headed), which can unify with
  // any pattern.
  factIndex: Map<string, Atom[]>;
  argIndex: Map<string, Atom[]>;
  nonGroundAtPos: Map<string, Atom[]>;
  varHeadedFacts: Atom[];
}

const KEY_SEP = "\x01";
const ARG_SEP = "\x00";

/** Index key for a ground-leaf first argument (symbol or grounded primitive); undefined for a variable,
 *  an expression, or a non-primitive grounded value (which are not first-argument indexable). */
function argKey(a: Atom): string | undefined {
  if (a.kind === "sym") return "s" + ARG_SEP + a.name;
  if (a.kind === "gnd") {
    const v = a.value;
    switch (v.g) {
      case "int":
        return "i" + ARG_SEP + v.n;
      case "float":
        return "f" + ARG_SEP + v.n;
      case "str":
        return "S" + ARG_SEP + v.s;
      case "bool":
        return "b" + ARG_SEP + (v.b ? "1" : "0");
      default:
        return undefined;
    }
  }
  return undefined;
}

function pushTo(m: Map<string, Atom[]>, k: string, x: Atom): void {
  const cur = m.get(k);
  if (cur === undefined) m.set(k, [x]);
  else cur.push(x);
}

/** An empty environment for grounding table `gt`. Grow it with `addAtomToEnv`. */
export function emptyEnv(gt: GroundingTable): MinEnv {
  return {
    ruleIndex: new Map(),
    varRules: [],
    sigs: new Map(),
    gt,
    atoms: [],
    types: new Map(),
    imports: new Map(),
    exprTypes: [],
    agt: new Map(),
    factIndex: new Map(),
    argIndex: new Map(),
    nonGroundAtPos: new Map(),
    varHeadedFacts: [],
  };
}

/** Incorporate one atom into `env` (mutating): rule index, signatures, types, and the atom list.
 *  Lets a sequential runner extend the env per atom instead of rebuilding it each query; correctness
 *  gated by the 270/270 oracle. */
export function addAtomToEnv(env: MinEnv, x: Atom): void {
  env.atoms.push(x);
  // Clause-index for fast `match` candidate selection: by functor, and by functor+first-arg when the
  // first argument is a ground leaf.
  const fk = headKey(x);
  if (fk === undefined) env.varHeadedFacts.push(x);
  else {
    pushTo(env.factIndex, fk, x);
    // Index by every argument position: a ground leaf goes in argIndex; a variable/expression argument
    // goes in nonGroundAtPos (it stays a candidate for any query that binds that position).
    if (x.kind === "expr")
      for (let i = 1; i < x.items.length; i++) {
        const ak = argKey(x.items[i]!);
        if (ak !== undefined) pushTo(env.argIndex, fk + KEY_SEP + i + KEY_SEP + ak, x);
        else pushTo(env.nonGroundAtPos, fk + KEY_SEP + i, x);
      }
  }
  if (opOf(x) === "=" && x.kind === "expr" && x.items.length === 3) {
    const lhs = x.items[1]!;
    const rhs = x.items[2]!;
    const k = headKey(lhs);
    if (k === undefined) env.varRules.push([lhs, rhs]);
    else {
      const cur = env.ruleIndex.get(k);
      if (cur === undefined) env.ruleIndex.set(k, [[lhs, rhs]]);
      else cur.push([lhs, rhs]);
    }
  }
  if (x.kind === "expr" && opOf(x) === ":" && x.items.length === 3) {
    const subj = x.items[1]!;
    const t = x.items[2]!;
    if (subj.kind === "sym") {
      if (opOf(t) === "->" && t.kind === "expr") env.sigs.set(subj.name, t.items.slice(1));
      env.types.set(subj.name, [...(env.types.get(subj.name) ?? []), t]);
    } else if (subj.kind === "expr") {
      env.exprTypes.push([subj, t]);
    }
  }
}

export function buildEnv(atoms: Atom[], gt: GroundingTable): MinEnv {
  const env = emptyEnv(gt);
  for (const x of atoms) addAtomToEnv(env, x);
  return env;
}

/** Register only the type declarations (`(: subj type)`) from imported atoms into the env, so an
 *  imported module's signatures drive type-directed evaluation. Rules are left to the space. */
function registerImportedTypes(env: MinEnv, atoms: readonly Atom[]): void {
  for (const x of atoms) {
    if (x.kind !== "expr" || opOf(x) !== ":" || x.items.length !== 3) continue;
    const subj = x.items[1]!;
    const t = x.items[2]!;
    if (subj.kind === "sym") {
      if (opOf(t) === "->" && t.kind === "expr") env.sigs.set(subj.name, t.items.slice(1));
      const cur = env.types.get(subj.name) ?? [];
      if (!cur.some((e) => atomEq(e, t))) env.types.set(subj.name, [...cur, t]);
    } else if (subj.kind === "expr") {
      if (!env.exprTypes.some(([s, tt]) => atomEq(s, subj) && atomEq(tt, t)))
        env.exprTypes.push([subj, t]);
    }
  }
}

/** The `&self` atoms (prelude + stdlib + KB in `env.atoms`, plus any dynamically added `selfExtra`).
 *  Returns `env.atoms` directly when nothing has been added dynamically (the common case), avoiding an
 *  O(atoms) spread allocation on every type/candidate/match lookup. Callers must not mutate the result. */
function selfAtoms(env: MinEnv, w: World): readonly Atom[] {
  return w.selfExtra.length === 0 ? env.atoms : [...env.atoms, ...w.selfExtra];
}

function candidates(env: MinEnv, toEval: Atom): Array<[Atom, Atom]> {
  const k = headKey(toEval);
  const keyed = k !== undefined ? (env.ruleIndex.get(k) ?? []) : [];
  return [...keyed, ...env.varRules];
}

// ---------- world + state ----------
export interface World {
  spaces: Map<string, Atom[]>;
  store: Map<number, Atom>;
  tokens: Map<string, Atom>;
  selfExtra: Atom[];
}
export interface St {
  counter: number;
  world: World;
}
export const initSt = (): St => ({
  counter: 0,
  world: { spaces: new Map(), store: new Map(), tokens: new Map(), selfExtra: [] },
});
function cloneWorld(w: World): World {
  return {
    spaces: new Map(w.spaces),
    store: new Map(w.store),
    tokens: new Map(w.tokens),
    selfExtra: w.selfExtra,
  };
}

// ---------- concurrent world merge (for `par`) ----------
// Each concurrent branch evaluates in isolation on the SAME immutable starting world, so they cannot
// see each other's mutations mid-flight. Their effects are merged afterwards as multiset deltas against
// the base: atoms a branch added are added, atoms it removed are removed, state/token writes that
// differ from the base are applied. Add-only effects (the common case) commute and the merge is
// order-independent; a genuine conflict (two branches mutating the same cell) resolves by branch order
// — deterministic, and the reason `with-mutex` exists (serialise such a section).
function multisetDelta(base: readonly Atom[], branch: readonly Atom[]): { added: Atom[]; removed: Atom[] } {
  const remaining = base.slice();
  const added: Atom[] = [];
  for (const a of branch) {
    const i = remaining.findIndex((x) => atomEq(x, a));
    if (i >= 0) remaining.splice(i, 1);
    else added.push(a);
  }
  return { added, removed: remaining };
}

function applyAtomDelta(into: Atom[], added: readonly Atom[], removed: readonly Atom[]): Atom[] {
  const out = into.slice();
  for (const r of removed) {
    const i = out.findIndex((x) => atomEq(x, r));
    if (i >= 0) out.splice(i, 1);
  }
  out.push(...added);
  return out;
}

function mergeWorlds(base: World, branches: readonly World[]): World {
  let selfExtra = base.selfExtra.slice();
  const spaces = new Map(base.spaces);
  const store = new Map(base.store);
  const tokens = new Map(base.tokens);
  for (const w of branches) {
    const d = multisetDelta(base.selfExtra, w.selfExtra);
    selfExtra = applyAtomDelta(selfExtra, d.added, d.removed);
    for (const [k, v] of w.spaces) {
      const baseV = base.spaces.get(k) ?? [];
      const sd = multisetDelta(baseV, v);
      spaces.set(k, applyAtomDelta(spaces.get(k) ?? baseV.slice(), sd.added, sd.removed));
    }
    for (const [k, v] of w.store) if (!Object.is(base.store.get(k), v)) store.set(k, v);
    for (const [k, v] of w.tokens) if (!Object.is(base.tokens.get(k), v)) tokens.set(k, v);
  }
  return { spaces, store, tokens, selfExtra };
}

/** A stable string key for a `with-mutex` lock name (a structural serialisation, no `format` dep). */
function mutexKey(a: Atom): string {
  switch (a.kind) {
    case "sym":
      return "s:" + a.name;
    case "var":
      return "v:" + a.name;
    case "gnd": {
      const g = a.value;
      return g.g === "str" ? "S:" + g.s : g.g === "int" || g.g === "float" ? "n:" + g.n : "g:" + g.g;
    }
    case "expr":
      return "e:[" + a.items.map(mutexKey).join(",") + "]";
  }
}

function resolveTok(w: World, a: Atom): Atom {
  if (a.kind === "sym") return w.tokens.get(a.name) ?? a;
  return a;
}
const stateHandle = (id: number): Atom => expr([sym("State"), gint(id)]);
function stateId(w: World, a: Atom): number | undefined {
  const r = resolveTok(w, a);
  if (opOf(r) === "State" && r.kind === "expr" && r.items.length === 2) {
    const g = r.items[1]!;
    if (g.kind === "gnd" && g.value.g === "int") return g.value.n;
  }
  return undefined;
}
function spaceName(w: World, a: Atom): string | undefined {
  const r = resolveTok(w, a);
  return r.kind === "sym" ? r.name : undefined;
}
function resolveStates(w: World, a: Atom): Atom {
  if (w.store.size === 0) return a; // no state cells: identity, skip the tree clone (hot path)
  if (a.kind === "expr") {
    if (opOf(a) === "State" && a.items.length === 2) {
      const g = a.items[1]!;
      if (g.kind === "gnd" && g.value.g === "int") return w.store.get(g.value.n) ?? a;
    }
    return expr(a.items.map((x) => resolveStates(w, x)));
  }
  return a;
}
function subTokens(w: World, a: Atom): Atom {
  if (w.tokens.size === 0) return a; // no bind! tokens: identity, skip the tree clone (hot path)
  if (a.kind === "sym") return w.tokens.get(a.name) ?? a;
  if (a.kind === "expr") return expr(a.items.map((x) => subTokens(w, x)));
  return a;
}
function wrapStates(w: World, a: Atom): Atom {
  if (w.store.size === 0) return a; // no state cells: identity, skip the tree clone (hot path)
  if (a.kind === "expr") {
    if (opOf(a) === "State" && a.items.length === 2) {
      const g = a.items[1]!;
      if (g.kind === "gnd" && g.value.g === "int") {
        const v = w.store.get(g.value.n);
        return v !== undefined ? expr([sym("StateValue"), v]) : a;
      }
    }
    return expr(a.items.map((x) => wrapStates(w, x)));
  }
  return a;
}
const typePrep = (w: World, a: Atom): Atom => wrapStates(w, subTokens(w, a));

function candidatesW(env: MinEnv, w: World, toEval: Atom): Array<[Atom, Atom]> {
  const extra: Array<[Atom, Atom]> = [];
  const k2 = headKey(toEval);
  for (const x of w.selfExtra) {
    if (opOf(x) === "=" && x.kind === "expr" && x.items.length === 3) {
      const lhs = x.items[1]!;
      const rhs = x.items[2]!;
      const k1 = headKey(lhs);
      if (k1 === undefined || k1 === k2) extra.push([lhs, rhs]);
    }
  }
  return [...candidates(env, toEval), ...extra];
}

export function freshenRule(counter: number, lhs: Atom, rhs: Atom): [Atom, Atom] {
  const vs = [...atomVars(lhs), ...atomVars(rhs).filter((v) => !atomVars(lhs).includes(v))];
  if (vs.length === 0) return [lhs, rhs];
  const sub: Subst = vs.map((v) => [v, variable(v + "#" + String(counter))]);
  return [applySubst(sub, lhs), applySubst(sub, rhs)];
}

// ---------- query + eval ops ----------
function queryOp(env: MinEnv, st: St, prev: Stack, toEval: Atom, b: Bindings): [Item[], St] {
  if (isVariableHeaded(toEval)) return [[finItem(prev, notReducibleA, b)], st];
  const cands = candidatesW(env, st.world, toEval);
  const out: Item[] = [];
  let counter = st.counter;
  for (const [lhs0, rhs0] of cands) {
    const [lhs, rhs] = freshenRule(counter, lhs0, rhs0);
    counter += 1;
    for (const mb of matchAtoms(lhs, toEval)) {
      for (const m of merge(b, mb)) {
        if (!hasLoop(m)) out.push(evalResult(prev, instantiate(m, rhs), m));
      }
    }
  }
  const st2: St = { counter, world: st.world };
  if (out.length === 0) return [[finItem(prev, notReducibleA, b)], st2];
  return [out, st2];
}

function* evalOpG(env: MinEnv, st: St, prev: Stack, x: Atom, b: Bindings): Gen<[Item[], St]> {
  const x2 = instantiate(b, x);
  const op = opOf(x2);
  if (op !== undefined && x2.kind === "expr") {
    const args = x2.items.slice(1).map((a) => resolveStates(st.world, subTokens(st.world, a)));
    const r = yield* callGroundedG(env, op, args);
    if (r.tag === "ok") return [r.results.map((res) => evalResult(prev, res, b)), st];
    if (r.tag === "runtimeError") return [[finItem(prev, errAtom(x2, r.msg), b)], st];
    if (r.tag === "incorrectArgument") return [[finItem(prev, notReducibleA, b)], st];
    // noReduce
  }
  // Executable grounded-atom head: `(<gnd-with-exec> arg...)`. This is what makes a grounded operation
  // produced at runtime (e.g. `(bind! abs (op-atom ...))` then `(abs -5)`, or the js-* interop) callable
  // in-language, the TS-native analogue of Python's py-atom/OperationAtom. The interpreter dispatches
  // built-in ops by symbol; this dispatches by the head atom's own `exec`.
  if (x2.kind === "expr" && x2.items.length > 0) {
    const head = x2.items[0]!;
    if (head.kind === "gnd" && head.exec !== undefined) {
      const args = x2.items.slice(1).map((a) => resolveStates(st.world, subTokens(st.world, a)));
      try {
        const results = head.exec(args);
        return [results.map((res) => evalResult(prev, res, b)), st];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return [[finItem(prev, errAtom(x2, msg), b)], st];
      }
    }
  }
  if (isEmbeddedOp(x2)) return [[{ stack: atomToStack(x2, prev), bnd: b }], st];
  return queryOp(env, st, prev, x2, b);
}

function unifyOp(prev: Stack, a: Atom, p: Atom, t: Atom, e: Atom, b: Bindings): Item[] {
  const ms: Item[] = [];
  for (const mb of matchAtoms(a, p))
    for (const m of merge(b, mb)) if (!hasLoop(m)) ms.push(finItem(prev, instantiate(m, t), m));
  return ms.length === 0 ? [finItem(prev, e, b)] : ms;
}

// ---------- final-item helpers ----------
const isFinal = (it: Item): boolean =>
  it.stack !== null && it.stack.tail === null && it.stack.head.fin;
function finalPair(it: Item): [Atom, Bindings] {
  const f = it.stack;
  return f === null ? [emptyA, []] : [instantiate(it.bnd, f.head.atom), it.bnd];
}
function exhaustedPair(it: Item): [Atom, Bindings] {
  const f = it.stack;
  return f === null
    ? [emptyA, it.bnd]
    : [expr([sym("Error"), instantiate(it.bnd, f.head.atom), sym("StackOverflow")]), it.bnd];
}

function resolveAtomFix(b: Bindings, n: number, a: Atom): Atom {
  let cur = a;
  for (let i = 0; i < n; i++) {
    const next = instantiate(b, cur);
    if (atomEq(next, cur)) return cur;
    cur = next;
  }
  return cur;
}
function restrictBnd(vars: readonly string[], b: Bindings): Bindings {
  const solved: BindingRel[] = [];
  for (const x of vars) {
    const v = resolveAtomFix(b, b.length + 1, variable(x));
    if (!(v.kind === "var" && v.name === x)) solved.push({ tag: "val", x, a: v, y: undefined });
  }
  const eqs = b.filter(
    (r): r is BindingRel => r.tag === "eq" && vars.includes(r.x) && vars.includes(r.y),
  );
  return [...solved, ...eqs];
}
function scopeVars(b: Bindings, prev: Stack): string[] {
  const out: string[] = [];
  for (let p = prev; p !== null; p = p.tail)
    for (const v of atomVars(instantiate(b, p.head.atom))) if (!out.includes(v)) out.push(v);
  return out;
}
function superposeItem(prev: Stack, b: Bindings, pair: Atom): Item {
  if (pair.kind === "expr" && pair.items.length > 0) return finItem(prev, pair.items[0]!, b);
  return finItem(prev, pair, b);
}

function argMask(ts: Atom[] | undefined, arity: number): boolean[] {
  if (ts === undefined) return Array<boolean>(arity).fill(true);
  return Array.from({ length: arity }, (_, i) => {
    const t = ts[i];
    if (t === undefined) return true;
    return !(atomEq(t, sym("Atom")) || atomEq(t, sym("Variable")) || atomEq(t, sym("Expression")));
  });
}
function returnsAtom(env: MinEnv, a: Atom): boolean {
  const op = headKey(a);
  if (op === undefined) return false;
  const ts = env.sigs.get(op);
  const last = ts && ts.length > 0 ? ts[ts.length - 1] : undefined;
  return last !== undefined && atomEq(last, sym("Atom"));
}

// ---------- types ----------
const headOr = (xs: readonly Atom[], d: Atom): Atom => (xs.length > 0 ? xs[0]! : d);
const UNDEF = sym("%Undefined%");
// Shared constant type-result arrays for the leaf cases: getTypes is on the hot path and these
// results are read-only (callers index/headOr them, never mutate), so a fresh array per call is
// pure allocation. (MORK-spirit: stop allocating on the hot path.)
const NUMBER_T: Atom[] = [sym("Number")];
const STRING_T: Atom[] = [sym("String")];
const BOOL_T: Atom[] = [sym("Bool")];
const GROUNDED_T: Atom[] = [sym("Grounded")];
const UNDEF_T: Atom[] = [UNDEF];

export function getTypes(env: MinEnv, a: Atom): Atom[] {
  if (a.kind === "gnd") {
    const g = a.value;
    if (g.g === "int" || g.g === "float") return NUMBER_T;
    if (g.g === "str") return STRING_T;
    if (g.g === "bool") return BOOL_T;
    return GROUNDED_T;
  }
  if (a.kind === "var") return UNDEF_T;
  if (a.kind === "sym") {
    const ts = env.types.get(a.name);
    return ts && ts.length > 0 ? ts : UNDEF_T;
  }
  // expression
  if (a.items.length === 0) return UNDEF_T;
  if (opOf(a) === "StateValue" && a.items.length === 2)
    return [expr([sym("StateMonad"), headOr(getTypes(env, a.items[1]!), UNDEF)])];
  const direct = env.exprTypes.filter((p) => atomEq(p[0], a));
  if (direct.length > 0) return direct.map((p) => p[1]);
  const f = a.items[0]!;
  const args = a.items.slice(1);
  const argTs = args.map((x) => headOr(getTypes(env, x), UNDEF));
  const out: Atom[] = [];
  for (const t of getTypes(env, f)) {
    if (opOf(t) === "->" && t.kind === "expr") {
      const ts = t.items.slice(1);
      const ret = ts.length > 0 ? ts[ts.length - 1]! : UNDEF;
      const params = ts.slice(0, -1);
      let tb: Bindings = [];
      for (let i = 0; i < params.length && i < argTs.length; i++) {
        const m = matchAtoms(instantiate(tb, params[i]!), argTs[i]!);
        if (m.length > 0) {
          const merged = merge(tb, m[0]!);
          if (merged.length > 0) tb = merged[0]!;
        }
      }
      out.push(instantiate(tb, ret));
    }
  }
  return out.length > 0 ? out : UNDEF_T;
}

function matchReduced(tb: Bindings, expected: Atom, actual: Atom): Bindings | undefined {
  if (atomEq(expected, UNDEF) || atomEq(actual, UNDEF)) return tb;
  if (expected.kind === "expr" && actual.kind === "expr")
    return matchReducedList(tb, expected.items, actual.items);
  for (const mb of matchAtoms(expected, actual)) {
    const merged = merge(tb, mb);
    if (merged.length > 0) return merged[0];
  }
  return undefined;
}
function matchReducedList(
  tb: Bindings,
  es: readonly Atom[],
  acts: readonly Atom[],
): Bindings | undefined {
  if (es.length !== acts.length) return undefined;
  let cur = tb;
  for (let i = 0; i < es.length; i++) {
    const r = matchReduced(cur, es[i]!, acts[i]!);
    if (r === undefined) return undefined;
    cur = r;
  }
  return cur;
}
function matchType(tb: Bindings, expected: Atom, actual: Atom): Bindings | undefined {
  if (
    atomEq(expected, UNDEF) ||
    atomEq(actual, UNDEF) ||
    atomEq(expected, sym("Atom")) ||
    atomEq(actual, sym("Atom"))
  )
    return tb;
  return matchReduced(tb, expected, actual);
}
function typeCheckArgs(
  env: MinEnv,
  w: World,
  argTypes: readonly Atom[],
  i: number,
  tb: Bindings,
  argsLeft: readonly Atom[],
): [number, Atom, Atom] | undefined {
  if (argsLeft.length === 0) return undefined;
  const ti0 = argTypes[i];
  if (ti0 === undefined) return undefined;
  const ti = instantiate(tb, ti0);
  const ai = argsLeft[0]!;
  const actuals = getTypes(env, typePrep(w, ai));
  for (const act of actuals) {
    const tb2 = matchType(tb, ti, act);
    if (tb2 !== undefined) return typeCheckArgs(env, w, argTypes, i + 1, tb2, argsLeft.slice(1));
  }
  return [i + 1, ti, headOr(actuals, UNDEF)];
}
function typeMismatch(
  env: MinEnv,
  w: World,
  op: string,
  args: readonly Atom[],
): [number, Atom, Atom] | undefined {
  const ts = env.sigs.get(op);
  if (ts === undefined) return undefined;
  return typeCheckArgs(env, w, ts.slice(0, -1), 0, [], args);
}

// ---------- conjunctive match ----------
/** Candidate `&self` atoms that could match a (instantiated) pattern, using the functor index. A
 *  functor-headed pattern only scans atoms with that head key plus the variable-headed atoms (which can
 *  unify with any functor); a variable-headed pattern must scan everything. State atoms are resolved
 *  only when the world actually holds state. This is what turns a linear `match` into an indexed one. */
function matchCandidates(env: MinEnv, w: World, pInst: Atom): readonly Atom[] {
  const k = headKey(pInst);
  if (k === undefined) {
    // variable-headed pattern: must consider everything.
    const all = w.selfExtra.length === 0 ? env.atoms.slice() : [...env.atoms, ...w.selfExtra];
    return resolveAll(w, all);
  }
  // Pick the most selective bound (ground-leaf) argument position: candidates are the atoms with that
  // ground value at that position, plus the atoms with a non-ground argument there (which can unify).
  let bestKey: string | undefined;
  let bestPosKey: string | undefined;
  let bestSize = Infinity;
  if (pInst.kind === "expr")
    for (let i = 1; i < pInst.items.length; i++) {
      const ak = argKey(pInst.items[i]!);
      if (ak === undefined) continue;
      const ik = k + KEY_SEP + i + KEY_SEP + ak;
      const posKey = k + KEY_SEP + i;
      const size = (env.argIndex.get(ik)?.length ?? 0) + (env.nonGroundAtPos.get(posKey)?.length ?? 0);
      if (size < bestSize) {
        bestSize = size;
        bestKey = ik;
        bestPosKey = posKey;
      }
    }
  let cands: Atom[];
  if (bestKey !== undefined) {
    cands = [...(env.argIndex.get(bestKey) ?? []), ...(env.nonGroundAtPos.get(bestPosKey!) ?? [])];
  } else {
    // no bound argument position: the whole functor bucket.
    cands = (env.factIndex.get(k) ?? []).slice();
  }
  cands.push(...env.varHeadedFacts);
  for (const a of w.selfExtra) {
    const akk = headKey(a);
    if (akk === undefined || akk === k) cands.push(a);
  }
  return resolveAll(w, cands);
}

/** Apply state resolution to candidate atoms only when the world actually holds state. */
function resolveAll(w: World, atoms: Atom[]): readonly Atom[] {
  return w.store.size === 0 ? atoms : atoms.map((x) => resolveStates(w, x));
}

function matchConj(
  getCandidates: (pInst: Atom) => readonly Atom[],
  patterns: readonly Atom[],
  st: St,
  sols: Bindings[],
): [Bindings[], St] {
  let cur = sols;
  let counter = st.counter;
  for (const p of patterns) {
    const next: Bindings[] = [];
    for (const b of cur) {
      const pInst = instantiate(b, p);
      for (const atom of getCandidates(pInst)) {
        const atom2 = freshenRule(counter, atom, atom)[0];
        counter += 1;
        for (const mb of matchAtoms(pInst, atom2))
          for (const m of merge(b, mb)) if (!hasLoop(m)) next.push(m);
      }
    }
    cur = next;
  }
  return [cur, { counter, world: st.world }];
}

// ---------- get-doc ----------
function getDocOf(env: MinEnv, w: World, atom: Atom): Atom {
  const atoms = selfAtoms(env, w);
  const ty =
    atom.kind === "sym"
      ? headOr(env.types.get(atom.name) ?? [], UNDEF)
      : (env.exprTypes.find((p) => atomEq(p[0], atom))?.[1] ?? UNDEF);
  const doc = atoms.find(
    (a) =>
      opOf(a) === "@doc" && a.kind === "expr" && a.items.length >= 2 && atomEq(a.items[1]!, atom),
  );
  if (doc === undefined || doc.kind !== "expr") return sym("Empty");
  if (doc.items.length === 5) {
    const desc = doc.items[2]!;
    const paramsWrap = doc.items[3]!;
    const retWrap = doc.items[4]!;
    const params = paramsWrap.kind === "expr" ? paramsWrap.items.slice(1)[0] : undefined;
    const paramList = params && params.kind === "expr" ? params.items : [];
    const retDesc = retWrap.kind === "expr" ? retWrap.items[1]! : UNDEF;
    const n = paramList.length;
    let paramTys: Atom[];
    let retTy: Atom;
    if (opOf(ty) === "->" && ty.kind === "expr" && ty.items.length - 1 === n + 1) {
      const rest = ty.items.slice(1);
      paramTys = rest.slice(0, -1);
      retTy = rest[rest.length - 1]!;
    } else {
      paramTys = Array<Atom>(n).fill(UNDEF);
      retTy = UNDEF;
    }
    const params2 = paramList.map((pp, i) => {
      if (opOf(pp) === "@param" && pp.kind === "expr" && pp.items.length === 2)
        return expr([
          sym("@param"),
          expr([sym("@type"), paramTys[i] ?? UNDEF]),
          expr([sym("@desc"), pp.items[1]!]),
        ]);
      return pp;
    });
    return expr([
      sym("@doc-formal"),
      expr([sym("@item"), atom]),
      expr([sym("@kind"), sym("function")]),
      expr([sym("@type"), ty]),
      desc,
      expr([sym("@params"), expr(params2)]),
      expr([sym("@return"), expr([sym("@type"), retTy]), expr([sym("@desc"), retDesc])]),
    ]);
  }
  if (doc.items.length === 3) {
    return expr([
      sym("@doc-formal"),
      expr([sym("@item"), atom]),
      expr([sym("@kind"), sym("atom")]),
      expr([sym("@type"), ty]),
      doc.items[2]!,
    ]);
  }
  return sym("Empty");
}

// ---------- the step function ----------
function* interpretStack1G(env: MinEnv, fuel: number, st: St, it: Item): Gen<[Item[], St]> {
  if (it.stack === null) return [[], st];
  const top = it.stack.head;
  const prev = it.stack.tail;
  if (top.fin) {
    if (prev === null) return [[it], st];
    const pf = prev.head;
    const pprev = prev.tail;
    const res = instantiate(it.bnd, top.atom);
    if (pf.ret === "chain") {
      if (opOf(pf.atom) === "chain" && pf.atom.kind === "expr" && pf.atom.items.length === 4) {
        const v = pf.atom.items[2]!;
        const templ = pf.atom.items[3]!;
        const nf = frame(expr([sym("chain"), res, v, templ]), pf.ret, pf.vars, false);
        return [[{ stack: cons(nf, pprev), bnd: it.bnd }], st];
      }
      return [[finItem(pprev, errAtom(pf.atom, "chain: corrupt frame"), it.bnd)], st];
    }
    if (pf.ret === "function") {
      if (opOf(res) === "return" && res.kind === "expr" && res.items.length === 2)
        return [[finItem(pprev, res.items[1]!, it.bnd)], st];
      if (isEmbeddedOp(res))
        return [[{ stack: atomToStack(res, cons(pf, pprev)), bnd: it.bnd }], st];
      const target = pprev !== null ? pprev.head.atom : res;
      return [[finItem(pprev, errAtom(target, "NoReturn"), it.bnd)], st];
    }
    return [[], st]; // Ret.none on a finished non-top frame
  }
  const a = top.atom;
  const op = opOf(a);
  const it2 = a.kind === "expr" ? a.items : [];
  switch (op) {
    case "eval":
      if (it2.length === 2) return yield* evalOpG(env, st, prev, it2[1]!, it.bnd);
      break;
    case "evalc":
      if (it2.length === 3) return yield* evalOpG(env, st, prev, it2[1]!, it.bnd);
      break;
    case "chain":
      if (it2.length === 4 && it2[2]!.kind === "var") {
        const v = (it2[2] as { name: string }).name;
        return [
          [{ stack: atomToStack(applySubst([[v, it2[1]!]], it2[3]!), prev), bnd: it.bnd }],
          st,
        ];
      }
      break;
    case "unify":
      if (it2.length === 5) return [unifyOp(prev, it2[1]!, it2[2]!, it2[3]!, it2[4]!, it.bnd), st];
      break;
    case "cons-atom":
      if (it2.length === 3 && it2[2]!.kind === "expr")
        return [[finItem(prev, expr([it2[1]!, ...it2[2]!.items]), it.bnd)], st];
      if (it2.length === 3)
        return [[finItem(prev, errAtom(a, "cons-atom: expected expression tail"), it.bnd)], st];
      break;
    case "decons-atom":
      if (it2.length === 2 && it2[1]!.kind === "expr" && it2[1]!.items.length > 0) {
        const [h, ...t] = it2[1]!.items;
        return [[finItem(prev, expr([h!, expr(t)]), it.bnd)], st];
      }
      if (it2.length === 2)
        return [
          [finItem(prev, errAtom(a, "decons-atom: expected non-empty expression"), it.bnd)],
          st,
        ];
      break;
    case "context-space":
      if (it2.length === 1) return [[finItem(prev, sym("&self"), it.bnd)], st];
      break;
    case "metta":
    case "capture":
    case "metta-thread": {
      const idx = 1;
      const atom = it2[idx]!;
      const [pairs, st2] = yield* mettaEvalG(env, fuel, st, it.bnd, atom);
      if (op === "metta-thread") {
        const out: Item[] = [];
        for (const p of pairs)
          for (const m of merge(it.bnd, restrictBnd(scopeVars(it.bnd, prev), p[1])))
            out.push(finItem(prev, p[0], m));
        return [out, st2];
      }
      return [pairs.map((p) => finItem(prev, p[0], it.bnd)), st2];
    }
    case "get-type":
    case "get-type-space": {
      const x = op === "get-type-space" ? it2[2]! : it2[1]!;
      return yield* getTypeOpG(env, fuel, st, prev, instantiate(it.bnd, x), it.bnd);
    }
    case "get-doc":
      if (it2.length === 2)
        return [[finItem(prev, getDocOf(env, st.world, instantiate(it.bnd, it2[1]!)), it.bnd)], st];
      break;
    case "match":
      if (it2.length === 4) return matchOp(env, st, prev, it2[1]!, it2[2]!, it2[3]!, it.bnd);
      break;
    case "superpose-bind":
      if (it2.length === 2 && it2[1]!.kind === "expr")
        return [it2[1]!.items.map((p) => superposeItem(prev, it.bnd, p)), st];
      break;
    case "collapse-bind": {
      if (it2.length !== 2) break;
      const [atoms, st2] = yield* interpretLoopG(env, fuel, st, [
        { stack: atomToStack(it2[1]!, null), bnd: it.bnd },
      ]);
      return [[finItem(prev, expr(atoms.map((p) => expr([p[0], unitA]))), it.bnd)], st2];
    }
    // TS-native extension. `(transaction <body>)` evaluates the body and atomically commits its
    // space mutations only if the body succeeds. Because the world is threaded copy-on-write
    // (cloneWorld -> new St), commit/rollback is snapshot-and-restore: keep the body's world on
    // success, restore the pre-body world otherwise. Rollback trigger (spec A2.1): the body throws
    // (an Error atom result) for every result, or produces zero results. The gensym counter always
    // advances (never reused after rollback).
    case "transaction": {
      if (it2.length !== 2) break;
      const snapshotWorld = st.world;
      const [pairs, st2] = yield* mettaEvalG(env, fuel, st, it.bnd, it2[1]!);
      const committed = pairs.length > 0 && pairs.some((p) => !isErrorAtom(p[0]));
      const world = committed ? st2.world : snapshotWorld;
      return [pairs.map((p) => finItem(prev, p[0], it.bnd)), { counter: st2.counter, world }];
    }
    // TS-native concurrency (async-only; see docs/.../concurrency-primitives.md).
    case "par": {
      // Evaluate every branch concurrently on the same immutable starting world, union their results,
      // and merge their effects as multiset deltas (add-only effects commute; conflicts -> with-mutex).
      const branches = it2.slice(1);
      pendingAsyncOp = "par";
      const results = (yield Promise.all(
        branches.map((br) => mettaEvalAsync(env, fuel, st, it.bnd, br)),
      )) as EvalRes[];
      const out: Item[] = [];
      let counter = st.counter;
      const worlds: World[] = [];
      for (const [pairs, st2] of results) {
        for (const p of pairs) out.push(finItem(prev, p[0], it.bnd));
        worlds.push(st2.world);
        if (st2.counter > counter) counter = st2.counter;
      }
      return [out, { counter, world: mergeWorlds(st.world, worlds) }];
    }
    case "race": {
      // First branch to produce a non-empty result wins; the losers are cancelled via the scope's
      // AbortSignal at their next await. "Skipped" here means a branch that yields no results or
      // throws at the JS level (an abort); a branch that returns MeTTa `(Error ...)` atoms produces
      // a non-empty result like any other value, so it can win the race.
      const branches = it2.slice(1);
      pendingAsyncOp = "race";
      const winner = (yield (async (): Promise<EvalRes> => {
        const ac = new AbortController();
        try {
          return await Promise.any(
            branches.map(async (br) => {
              const r = await mettaEvalAsync(env, fuel, st, it.bnd, br, ac.signal);
              if (r[0].length === 0) throw new Error("empty branch");
              return r;
            }),
          );
        } catch {
          return [[], st];
        } finally {
          ac.abort();
        }
      })()) as EvalRes;
      return [winner[0].map((p) => finItem(prev, p[0], it.bnd)), winner[1]];
    }
    case "once": {
      // Cut nondeterminism to the first result. Works in both drivers (yield* propagates); it is only
      // async when its argument is (e.g. (once (par ...))).
      if (it2.length !== 2) break;
      const [pairs, st2] = yield* mettaEvalG(env, fuel, st, it.bnd, it2[1]!);
      const first = pairs.length > 0 ? [pairs[0]!] : [];
      return [first.map((p) => finItem(prev, p[0], it.bnd)), st2];
    }
    case "with-mutex": {
      // Serialise the body against other `with-mutex` sections of the same name (canonical async
      // Promise-chain lock; release in finally so a throwing/empty body still unlocks).
      if (it2.length !== 3) break;
      const name = mutexKey(instantiate(it.bnd, it2[1]!));
      const body = it2[2]!;
      pendingAsyncOp = "with-mutex";
      const result = (yield (async (): Promise<EvalRes> => {
        const prior = MUTEXES.get(name) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        MUTEXES.set(name, prior.then(() => held));
        await prior;
        try {
          return await mettaEvalAsync(env, fuel, st, it.bnd, body);
        } finally {
          release();
        }
      })()) as EvalRes;
      return [result[0].map((p) => finItem(prev, p[0], it.bnd)), result[1]];
    }
    case "new-state": {
      if (it2.length !== 2) break;
      const id = st.counter;
      const w = cloneWorld(st.world);
      w.store.set(id, instantiate(it.bnd, it2[1]!));
      return [[finItem(prev, stateHandle(id), it.bnd)], { counter: id + 1, world: w }];
    }
    case "get-state": {
      if (it2.length !== 2) break;
      const id = stateId(st.world, instantiate(it.bnd, it2[1]!));
      if (id !== undefined) return [[finItem(prev, st.world.store.get(id) ?? emptyA, it.bnd)], st];
      return [
        [finItem(prev, errAtom(instantiate(it.bnd, it2[1]!), "get-state: not a state"), it.bnd)],
        st,
      ];
    }
    case "change-state!": {
      if (it2.length !== 3) break;
      const id = stateId(st.world, instantiate(it.bnd, it2[1]!));
      if (id !== undefined) {
        const w = cloneWorld(st.world);
        w.store.set(id, instantiate(it.bnd, it2[2]!));
        return [[finItem(prev, stateHandle(id), it.bnd)], { counter: st.counter, world: w }];
      }
      return [
        [
          finItem(
            prev,
            errAtom(instantiate(it.bnd, it2[1]!), "change-state!: not a state"),
            it.bnd,
          ),
        ],
        st,
      ];
    }
    case "new-space":
    case "new-mork-space": {
      const id = st.counter;
      const name = "&space-" + String(id);
      const w = cloneWorld(st.world);
      w.spaces.set(name, []);
      return [[finItem(prev, sym(name), it.bnd)], { counter: id + 1, world: w }];
    }
    case "fork-space": {
      if (it2.length !== 2) break;
      const src = spaceName(st.world, instantiate(it.bnd, it2[1]!));
      if (src === undefined)
        return [
          [finItem(prev, errAtom(instantiate(it.bnd, it2[1]!), "fork-space: not a space"), it.bnd)],
          st,
        ];
      const srcAtoms =
        src === "&self" ? selfAtoms(env, st.world) : (st.world.spaces.get(src) ?? []);
      const id = st.counter;
      const name = "&space-" + String(id);
      const w = cloneWorld(st.world);
      w.spaces.set(name, [...srcAtoms]);
      return [[finItem(prev, sym(name), it.bnd)], { counter: id + 1, world: w }];
    }
    case "add-atom":
      if (it2.length === 3)
        return spaceMutate(st, prev, it2[1]!, it.bnd, (w, name) =>
          appendSpace(w, name, [instantiate(it.bnd, it2[2]!)]),
        );
      break;
    case "remove-atom":
      if (it2.length === 3)
        return spaceMutate(st, prev, it2[1]!, it.bnd, (w, name) =>
          eraseSpace(w, name, instantiate(it.bnd, it2[2]!)),
        );
      break;
    case "get-atoms": {
      if (it2.length !== 2) break;
      const name = spaceName(st.world, instantiate(it.bnd, it2[1]!));
      if (name === undefined)
        return [
          [finItem(prev, errAtom(instantiate(it.bnd, it2[1]!), "get-atoms: not a space"), it.bnd)],
          st,
        ];
      const list =
        name === "&self"
          ? selfAtoms(env, st.world)
          : (st.world.spaces.get(name) ?? []);
      return [list.map((x) => finItem(prev, x, it.bnd)), st];
    }
    case "bind!": {
      if (it2.length !== 3) break;
      const tok = instantiate(it.bnd, it2[1]!);
      if (tok.kind === "sym") {
        const w = cloneWorld(st.world);
        w.tokens.set(tok.name, instantiate(it.bnd, it2[2]!));
        return [[finItem(prev, emptyExpr, it.bnd)], { counter: st.counter, world: w }];
      }
      return [[finItem(prev, errAtom(tok, "bind!: token must be a symbol"), it.bnd)], st];
    }
    case "import!": {
      if (it2.length !== 3) break;
      const fileAtom = instantiate(it.bnd, it2[2]!);
      const fileAtoms = fileAtom.kind === "sym" ? (env.imports.get(fileAtom.name) ?? []) : [];
      // Bring the module's type signatures into the env so type-directed evaluation sees them (a
      // sig in a space's atom list is not consulted by `env.sigs`). Rules stay in the space and are
      // read dynamically by candidate selection.
      registerImportedTypes(env, fileAtoms);
      return spaceMutate(st, prev, it2[1]!, it.bnd, (w, name) => appendSpace(w, name, fileAtoms));
    }
    default:
      break;
  }
  if (isEmbeddedOp(a)) return [[finItem(prev, errAtom(a, "unsupported minimal op"), it.bnd)], st];
  return [[{ stack: cons(frame(top.atom, top.ret, top.vars, true), prev), bnd: it.bnd }], st];
}

// space-mutation helpers used by add/remove/import
function appendSpace(w0: World, name: string, atoms: Atom[]): World {
  const w = cloneWorld(w0);
  if (name === "&self") w.selfExtra = [...w.selfExtra, ...atoms];
  else w.spaces.set(name, [...(w.spaces.get(name) ?? []), ...atoms]);
  return w;
}
function eraseSpace(w0: World, name: string, a: Atom): World {
  const w = cloneWorld(w0);
  const erase1 = (xs: Atom[]): Atom[] => {
    const i = xs.findIndex((y) => atomEq(y, a));
    return i < 0 ? xs : [...xs.slice(0, i), ...xs.slice(i + 1)];
  };
  if (name === "&self") w.selfExtra = erase1(w.selfExtra);
  else w.spaces.set(name, erase1(w.spaces.get(name) ?? []));
  return w;
}
function spaceMutate(
  st: St,
  prev: Stack,
  s: Atom,
  b: Bindings,
  f: (w: World, name: string) => World,
): [Item[], St] {
  const name = spaceName(st.world, instantiate(b, s));
  if (name === undefined)
    return [[finItem(prev, errAtom(instantiate(b, s), "not a space"), b)], st];
  return [[finItem(prev, emptyExpr, b)], { counter: st.counter, world: f(st.world, name) }];
}

function* getTypeOpG(
  env: MinEnv,
  fuel: number,
  st: St,
  prev: Stack,
  xi: Atom,
  b: Bindings,
): Gen<[Item[], St]> {
  const emit = function* (st0: St): Gen<[Item[], St]> {
    let acc: Item[] = [];
    let cur = st0;
    for (const t of getTypes(env, typePrep(st.world, xi))) {
      const [rs, st2] = yield* mettaEvalG(env, fuel, cur, b, t);
      acc = [...acc, ...rs.map((p) => finItem(prev, p[0], b))];
      cur = st2;
    }
    return [acc, cur];
  };
  if (xi.kind === "expr" && xi.items.length > 0) {
    const head = xi.items[0]!;
    const args = xi.items.slice(1);
    if (head.kind === "sym") {
      if (typeMismatch(env, st.world, head.name, args) !== undefined) return [[], st];
      return yield* emit(st);
    }
    const illTyped = getTypes(env, typePrep(st.world, head)).some((ft) => {
      if (opOf(ft) === "->" && ft.kind === "expr")
        return typeCheckArgs(env, st.world, ft.items.slice(1, -1), 0, [], args) !== undefined;
      return false;
    });
    return illTyped ? [[], st] : yield* emit(st);
  }
  return yield* emit(st);
}

function matchOp(
  env: MinEnv,
  st: St,
  prev: Stack,
  space: Atom,
  pattern: Atom,
  template: Atom,
  b: Bindings,
): [Item[], St] {
  const sn = spaceName(st.world, instantiate(b, space));
  const subbed = subTokens(st.world, pattern);
  const patterns =
    opOf(subbed) === "," && subbed.kind === "expr"
      ? subbed.items.slice(1).map((p) => resolveStates(st.world, p))
      : [resolveStates(st.world, subbed)];
  // &self uses the functor index; a named space scans its (smaller) atom list directly.
  let getCandidates: (pInst: Atom) => readonly Atom[];
  if (sn === undefined || sn === "&self") {
    getCandidates = (pInst) => matchCandidates(env, st.world, pInst);
  } else {
    const named = (st.world.spaces.get(sn) ?? []).map((x) => resolveStates(st.world, x));
    getCandidates = () => named;
  }
  const [sols, st2] = matchConj(getCandidates, patterns, st, [b]);
  const out: Item[] = [];
  for (const m of sols) if (!hasLoop(m)) out.push(finItem(prev, instantiate(m, template), m));
  return [out, st2];
}

// ---------- driver (iterative) ----------
function* interpretLoopG(
  env: MinEnv,
  fuel: number,
  st: St,
  work: Item[],
): Gen<[Array<[Atom, Bindings]>, St]> {
  const done: Array<[Atom, Bindings]> = [];
  let queue = work;
  let cur = st;
  let f = fuel;
  while (queue.length > 0) {
    if (f <= 0) {
      for (const it of queue) done.push(isFinal(it) ? finalPair(it) : exhaustedPair(it));
      return [done, cur];
    }
    const it = queue[0]!;
    queue = queue.slice(1);
    const [results, st2] = yield* interpretStack1G(env, f - 1, cur, it);
    cur = st2;
    f -= 1;
    const more: Item[] = [];
    for (const r of results) {
      if (isFinal(r)) done.push(finalPair(r));
      else more.push(r);
    }
    queue = [...more, ...queue];
  }
  return [done, cur];
}

// ---------- mettaEval (type-directed metta-call loop) ----------
function* mettaEvalG(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
): Gen<[Array<[Atom, Bindings]>, St]> {
  if (fuel <= 0)
    return [[[expr([sym("Error"), instantiate(bnd, a), sym("StackOverflow")]), bnd]], st];
  const w = instantiate(bnd, a);
  const isErr = (x: Atom): boolean =>
    x.kind === "expr" &&
    x.items.length >= 1 &&
    x.items[0]!.kind === "sym" &&
    (x.items[0] as { name: string }).name === "Error";

  if (w.kind === "expr" && w.items.length > 0 && w.items[0]!.kind === "sym") {
    const op = (w.items[0] as { name: string }).name;
    const args = w.items.slice(1);
    const mm = typeMismatch(env, st.world, op, args);
    if (mm !== undefined) {
      const [pos, expected, actual] = mm;
      return [
        [
          [
            expr([
              sym("Error"),
              expr([sym(op), ...args]),
              expr([sym("BadArgType"), gint(pos), expected, actual]),
            ]),
            bnd,
          ],
        ],
        st,
      ];
    }
    const queryVars = args.flatMap((x) => atomVars(x));
    // Fetch this operator's signature once and reuse it (avoids repeated Map lookups across
    // argMask + the per-result returnsAtom check in the reduce loop below).
    const sig = env.sigs.get(op);
    const opReturnsAtom =
      sig !== undefined && sig.length > 0 && atomEq(sig[sig.length - 1]!, sym("Atom"));
    // Concurrency primitives drive their own branches; their arguments stay unevaluated regardless of
    // arity, so a `par`/`race`/`with-mutex` branch is evaluated concurrently, not eagerly in sequence.
    const mask = LAZY_ARGS_OPS.has(op) ? args.map(() => false) : argMask(sig, args.length);
    // (1) type-directed argument evaluation, binding-threaded
    let partials: Array<[Atom[], Bindings]> = [[[], []]];
    let cur = st;
    for (let i = 0; i < args.length; i++) {
      const ae = args[i]!;
      const evalThis = mask[i]!;
      const nextParts: Array<[Atom[], Bindings]> = [];
      for (const [accAtoms, accB] of partials) {
        if (evalThis) {
          const [ps, st2] = yield* mettaEvalG(env, fuel - 1, cur, accB, ae);
          cur = st2;
          for (const p of ps) {
            const mergedHead = merge(accB, p[1]);
            const nb = restrictBnd(queryVars, mergedHead.length > 0 ? mergedHead[0]! : p[1]);
            nextParts.push([[...accAtoms, p[0]], nb]);
          }
        } else {
          nextParts.push([[...accAtoms, instantiate(accB, ae)], accB]);
        }
      }
      partials = nextParts;
    }
    // (2) reduce each combination
    const out: Array<[Atom, Bindings]> = [];
    let cur2 = cur;
    for (const [partAtoms, partB] of partials) {
      // error propagation: a type-directed-evaluated arg reduced to an error and changed
      let errFound: Atom | undefined;
      for (let i = 0; i < partAtoms.length; i++) {
        if (isErr(partAtoms[i]!) && !atomEq(partAtoms[i]!, args[i]!)) {
          errFound = partAtoms[i]!;
          break;
        }
      }
      if (errFound !== undefined) {
        out.push([errFound, partB]);
        continue;
      }
      const wApp = expr([sym(op), ...partAtoms]);
      const [pairs, st3] = yield* interpretLoopG(env, fuel, cur2, [
        { stack: atomToStack(expr([sym("eval"), wApp]), null), bnd },
      ]);
      cur2 = st3;
      for (const p of pairs) {
        const mergedPb = merge(partB, p[1]);
        const pb = restrictBnd(queryVars, mergedPb.length > 0 ? mergedPb[0]! : p[1]);
        if (atomEq(p[0], notReducibleA) || atomEq(p[0], wApp)) {
          out.push([wApp, partB]);
        } else if (opReturnsAtom && !isEmbeddedOp(p[0])) {
          out.push([p[0], pb]);
        } else {
          const [more, st4] = yield* mettaEvalG(env, fuel - 1, cur2, pb, p[0]);
          cur2 = st4;
          for (const m of more) {
            const mm2 = merge(pb, m[1]);
            out.push([m[0], restrictBnd(queryVars, mm2.length > 0 ? mm2[0]! : m[1])]);
          }
        }
      }
    }
    return [out, cur2];
  }

  if (w.kind === "expr" && w.items.length > 0) {
    // expression-headed application
    const [ruleRes, st1] = yield* interpretLoopG(env, fuel, st, [
      { stack: atomToStack(expr([sym("eval"), w]), null), bnd },
    ]);
    const reduced = ruleRes.filter((p) => !atomEq(p[0], w) && !atomEq(p[0], notReducibleA));
    if (reduced.length === 0) {
      const [tupleRes, st2] = yield* interpretLoopG(env, fuel, st1, [
        {
          stack: atomToStack(
            expr([sym("eval"), expr([sym("interpret-tuple"), w, sym("&self")])]),
            null,
          ),
          bnd,
        },
      ]);
      const out: Array<[Atom, Bindings]> = [];
      let cur = st2;
      for (const p of tupleRes) {
        if (atomEq(p[0], w)) out.push(p);
        else {
          const [more, st3] = yield* mettaEvalG(env, fuel - 1, cur, p[1], p[0]);
          cur = st3;
          out.push(...more);
        }
      }
      return [out, cur];
    }
    const out: Array<[Atom, Bindings]> = [];
    let cur = st1;
    for (const p of reduced) {
      const [more, st3] = yield* mettaEvalG(env, fuel - 1, cur, p[1], p[0]);
      cur = st3;
      out.push(...more);
    }
    return [out, cur];
  }

  // bare symbol / variable / grounded
  const [pairs, st1] = yield* interpretLoopG(env, fuel, st, [
    { stack: atomToStack(expr([sym("eval"), w]), null), bnd },
  ]);
  const out: Array<[Atom, Bindings]> = [];
  let cur = st1;
  for (const p of pairs) {
    if (atomEq(p[0], notReducibleA) || atomEq(p[0], w)) out.push([w, bnd]);
    else if (returnsAtom(env, w) && !isEmbeddedOp(p[0])) out.push(p);
    else {
      const [more, st3] = yield* mettaEvalG(env, fuel - 1, cur, p[1], p[0]);
      cur = st3;
      out.push(...more);
    }
  }
  return [out, cur];
}

// ---------- public API ----------
const DEFAULT_FUEL = 2_000_000;

/** Type-directed evaluation of `a` (the sync driver: throws `AsyncInSyncError` if it reaches an async
 *  grounded op). This is the public synchronous entry point with the original signature. */
function mettaEval(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
): [Array<[Atom, Bindings]>, St] {
  return runGenSync(mettaEvalG(env, fuel, st, bnd, a));
}

/** Async type-directed evaluation: awaits async grounded operations (`env.agt`). An optional `signal`
 *  makes it cancellable (used by `race` to stop losing branches). */
export function mettaEvalAsync(
  env: MinEnv,
  fuel: number,
  st: St,
  bnd: Bindings,
  a: Atom,
  signal?: AbortSignal,
): Promise<[Array<[Atom, Bindings]>, St]> {
  return runGenAsync(mettaEvalG(env, fuel, st, bnd, a), signal);
}

/** Evaluate `atom` (i.e. interpret `(eval atom)`) under `env`, returning the result atoms. */
export function evalAtom(
  env: MinEnv,
  atom: Atom,
  st: St = initSt(),
  fuel = DEFAULT_FUEL,
): [Atom[], St] {
  const [pairs, st2] = mettaEval(env, fuel, st, [], atom);
  return [pairs.map((p) => p[0]), st2];
}

export { mettaEval };
