// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Typed combinators for MeTTa's special forms and standard-library operations. Each maps to a real
// symbol the interpreter knows (the prelude/stdlib defines `=`, `:`, `->`, `if`, `case`, `let`, `let*`,
// `match`, `superpose`, `collapse`, `empty`, `unify`, the arithmetic/comparison/boolean grounded ops,
// and the list ops). Re-deriving these as builders (rather than typing them out as `S("if")` by hand)
// keeps construction terse while staying exactly faithful to MeTTa's evaluation model.
import { E, S, type ExpressionAtom } from "@metta-ts/hyperon";
import { ground, type Term } from "./term";

/** A rewrite rule `(= head body)`. Define several with the same head for nondeterministic results. */
export const rule = (head: Term, body: Term): ExpressionAtom => E(S("="), ground(head), ground(body));

/** A type declaration `(: subject type)`. */
export const decl = (subject: Term, type: Term): ExpressionAtom => E(S(":"), ground(subject), ground(type));

/** A function type `(-> A B ... R)`. */
export const arrow = (...types: Term[]): ExpressionAtom => E(S("->"), ...types.map(ground));

/** `(if cond then else)`. Only the taken branch is evaluated. */
export const iff = (cond: Term, then: Term, els: Term): ExpressionAtom =>
  E(S("if"), ground(cond), ground(then), ground(els));

/** `(case scrutinee ((pat body) ...))`, sequential mutually-exclusive pattern matching. */
export const caseOf = (scrutinee: Term, cases: ReadonlyArray<readonly [Term, Term]>): ExpressionAtom =>
  E(S("case"), ground(scrutinee), E(...cases.map(([pat, body]) => E(ground(pat), ground(body)))));

/** `(let pattern value body)`: unify `value` against `pattern`, then evaluate `body`. */
export const lett = (pattern: Term, value: Term, body: Term): ExpressionAtom =>
  E(S("let"), ground(pattern), ground(value), ground(body));

/** `(let* ((pat val) ...) body)`: sequential lets. */
export const letStar = (bindings: ReadonlyArray<readonly [Term, Term]>, body: Term): ExpressionAtom =>
  E(S("let*"), E(...bindings.map(([pat, val]) => E(ground(pat), ground(val)))), ground(body));

/** `(match space pattern template)`. Defaults to `&self`, the program's own space. */
export const matchSelf = (pattern: Term, template: Term, space: Term = S("&self")): ExpressionAtom =>
  E(S("match"), ground(space), ground(pattern), ground(template));

/** `(superpose (a b ...))`: a nondeterministic choice among the items. */
export const superpose = (...items: Term[]): ExpressionAtom => E(S("superpose"), E(...items.map(ground)));

/** `(collapse x)`: gather all nondeterministic results of `x` into a single expression. */
export const collapse = (x: Term): ExpressionAtom => E(S("collapse"), ground(x));

/** `(empty)`: the empty result set (no results), MeTTa's way to prune a branch. */
export const empty = (): ExpressionAtom => E(S("empty"));

/** `(unify a b then else)`: low-level unification with then/else continuations. */
export const unify = (a: Term, b: Term, then: Term, els: Term): ExpressionAtom =>
  E(S("unify"), ground(a), ground(b), ground(then), ground(els));

const op2 =
  (name: string) =>
  (a: Term, b: Term): ExpressionAtom =>
    E(S(name), ground(a), ground(b));

/** Arithmetic grounded operations. */
export const add = op2("+");
export const sub = op2("-");
export const mul = op2("*");
export const div = op2("/");
export const mod = op2("%");

/** Comparison grounded operations (return `True`/`False`). */
export const eq = op2("==");
export const gt = op2(">");
export const lt = op2("<");
export const ge = op2(">=");
export const le = op2("<=");

/** Boolean grounded operations. */
export const and = op2("and");
export const or = op2("or");
export const not = (x: Term): ExpressionAtom => E(S("not"), ground(x));

/** Expression/list grounded operations. */
export const carAtom = (x: Term): ExpressionAtom => E(S("car-atom"), ground(x));
export const cdrAtom = (x: Term): ExpressionAtom => E(S("cdr-atom"), ground(x));
export const consAtom = (head: Term, tail: Term): ExpressionAtom => E(S("cons-atom"), ground(head), ground(tail));
