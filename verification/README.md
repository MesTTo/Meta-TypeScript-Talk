# Formal verification (LemmaScript)

Machine-checked proofs of the pure-core invariants, complementing the 270/270 differential oracle. Annotated TypeScript (`//@` comments) is transpiled by [LemmaScript](https://lemmascript.com/) (`lsc`) to Dafny (or Lean 4) and discharged by the prover. The annotations are comments — they do not affect the executable or the bundle.

## What is proven (Dafny + Z3, 0 errors)

| file | theorem | why it matters |
|------|---------|----------------|
| `clamp.ts` | result stays within `[lo, hi]` | toolchain smoke test |
| `terms.ts` | `termSize(t) >= 1` | the `unifyTop` termination measure (`unify.ts` uses `atomSize(a)+atomSize(b)` as fuel) is always positive — the measure is well-founded |
| `bindings.ts` | `lookupFirst` returns a value actually bound to the key | soundness of `bindings.ts` `lookupVal`, the matcher's core lookup |

Run: `pnpm verify` (needs Dafny ≥ 4.x and Z3 4.12.x on `PATH`, plus the `lemmascript` dev dep).

## Scope (honest boundary)

LemmaScript is a tech preview that verifies a TypeScript subset. The real `Atom` is a discriminated union carrying **function-valued** grounded fields (`exec`/`match`), which is outside that subset, so the full `eval.ts` matcher/evaluator cannot be transpiled wholesale. The invariants above are therefore verified on **function-free models** that faithfully mirror the structural core (the same invariants LeaTTa proves in Lean for the real types). The full interpreter stays covered by the differential oracle (270/270 against the Lean-verified LeaTTa). This is the tiered verification we use: tests, then a differential oracle, then formal proof of the tractable core.
