# Benchmark results

Pure TypeScript, no native addon, no WASM. Node v22, single core.
Run: `pnpm bench` (builds core, then deopt-aware mitata).

## Hot paths (mitata)

| benchmark | time/iter |
|-----------|-----------|
| `matchAtoms` symbol mismatch | ~9 ns |
| `matchAtoms` nested, binds 2 vars | ~222 ns |
| `match` over a 1000-atom space | ~201 µs |
| `fib(15)` (~1.2k recursive calls) | ~17 ms |
| stdlib load + `(+ 1 2)` | ~12 µs |
| full 270-assertion Hyperon oracle | ~39 ms |

## Optimization log (profile-driven, each gated by the 270/270 oracle)

Method: `node --prof` to find hot spots, research the V8/interpreter technique, apply, re-measure, keep only if the oracle stays 270/270. Inspiration drawn from MORK (interned/flat representation, avoid allocation).

1. **Incremental env build** — extend `MinEnv` per atom instead of rebuilding it on every query.
2. **State/token short-circuit** — `subTokens`/`resolveStates`/`wrapStates` return the atom unchanged when the world has no tokens/states (skips a full tree clone on every grounded-op eval). Oracle 62 → 47 ms.
3. **`applySubst` structural sharing** — skip empty substitutions and return the same reference when a subtree is unchanged (no clone). `fib` ↓ ~25%.
4. **Precomputed `ground` flag** (a closed-term short-circuit: `if (this.ground) return this`) — `applySubst`/`atomVars`/`occurs` short-circuit instantly on closed terms; plus shared constant leaf type-arrays in `getTypes`. Oracle → ~39 ms; 1000-atom match 321 → 201 µs; `fib(15)` 26.6 → 17.4 ms.

Net: the full oracle went from ~62 ms to ~39 ms (~37% faster) and `fib(15)` from ~26.6 ms to ~17.4 ms (~35% faster), correctness unchanged at 270/270.

5. **Interpreter stack as a cons-list** — `Stack` is an immutable `{head, tail}` cons-list, so per-step push/rest are O(1) instead of array `slice(1)`/spread (which the profile flagged as `ArrayPrototypeSlice`). Helps deep recursion most.

## Functor (first-argument) indexing — the scaling lever, shipped

`match` over `&self` was a linear scan of every atom, so it did not scale. Now `&self` atoms are
indexed by head functor at insert time (Prolog-style clause indexing): a functor-headed query
(`(Parent $x Bob)`) only scans atoms with that functor plus the variable-headed atoms; a
variable-headed query still scans everything. Built once at `addAtomToEnv`, so it is free per query.

Two levels: by **head functor**, and by **functor + argument position + value** for every ground-leaf
argument (so a single huge relation is queryable by *any* key). A query picks the most selective bound
argument position; a fully-unbound (variable-headed) query scans everything.

Measured:
- `match (Parent $x Bob)` over a **1,000,000-atom** KB (diverse functors): **~0.5 ms** (skips the 1M
  unrelated-functor atoms).
- `match (edge 500000 $y)` over **1,000,000** atoms that all share the `edge` functor:
  **~75 ms → ~1.4 ms** (~50x; the argument index jumps to the keyed row).
- `match (edge $x 7)` over the same 1M (query by the *second* argument): **~152 ms → ~0.2 ms** (every
  position is indexed, not just the first).
- 1000-atom-space match bench: **~190 µs → ~64 µs (functor) → ~3.6 µs (first-arg)**.
- full 270-assertion oracle: **~46 ms → ~22.5 ms** (~2x; the index also skips the ~130 prelude/stdlib
  atoms on every candidate/match lookup, so it more than pays back the always-loaded stdlib's ~8%).

Correctness gated by the 270/270 oracle plus dedicated multi-result / variable-headed / conjunctive
match tests. This is the in-memory half of the "scale to millions of atoms" goal; the flat-KB +
worker parallel matcher is an alternative for KB sizes that exceed single-threaded scan capacity.

## Parallel flat matcher (worker_threads + SharedArrayBuffer) — shipped

`ParallelFlatMatcher` (`@metta-ts/node`) puts a flat interned KB's Int32 tokens in a `SharedArrayBuffer`
and a warm pool of `worker_threads` claim fact offsets via an `Atomics` work-stealing counter, scanning
their share with plain reads (an immutable shared region is data-race-free). Results are identical to
the single-threaded `FlatKB.match` (differential-tested).

Measured (8 workers, AMD Ryzen 9 9950X, Node 22):
- **Scan-bound, few results** — `(rec $x rare)` over **4,000,000** atoms (~4000 matches): single-thread
  ~175 ms → parallel **~111 ms (1.57x)**. The scan parallelises and little is marshalled back.
- **Result-heavy** — a query matching ~285k of 2,000,000: single-thread ~130 ms → parallel ~253 ms
  (**0.5x, slower**). Returning hundreds of thousands of matches from workers costs more than the saved
  scan.

So this is a **niche** tool, worth it only for a *large KB* scanned by a
*non-selective* query whose *result set is small* (a needle in a haystack, a count). A keyed query is
already ~constant-time via the in-memory argument index (above) — do not parallelise that. Node-first;
the same Int32 layout ports to Web Workers + SAB under cross-origin isolation (COOP/COEP) later.

## William compression — heavy repeated-subpattern mining (shipped)

`williamTopK(kb, k, refCost)` (`@metta-ts/core`, `flat-william.ts`) finds the top-k most-compressible
repeated subpatterns in a flat interned KB, ranked by compression gain (MORK / Hyperon whitepaper
§5.12). Factoring `count` copies of a `len`-token subpattern into one definition plus `count` references
saves `gain(count, len) = (count - 1) * len - count * refCost` tokens; the top-k by gain are the patterns
most worth abstracting and the most informative frequent structure. It walks the same Int32 token layout
as the flat matcher, counting every subterm by its exact token sequence.

This is MORK's slice **S1**: the correct brute-force top-k, the oracle for any later branch-and-bound or
streaming index. Correctness is gated by a differential test against an independent tree-walking miner
(`flat-william.test.ts`, 19 cases across five corpora × three reference costs), plus economics tests
(single symbols never pay to factor; a reference costlier than the pattern is always a net loss however
frequent; higher `refCost` prunes marginal patterns).

Measured (`(obs <i> (kind road) (region north))` rows, two heavy subterms per fact, AMD Ryzen 9 9950X,
Node 22, min of 3):
- **10,000** facts: top-5 in **~13 ms**.
- **100,000** facts: top-5 in **~113 ms**.
- **1,000,000** facts (~9M subterm visits): top-5 in **~1.4 s**, correctly surfacing both
  1,000,000-occurrence subterms.

Linear in the number of subterms, as expected for the brute-force pass. The cost is the per-subterm
string key (a comma-joined token slice used as the count-map key); a rolling integer hash over the token
range is the obvious next optimization, and an output-sensitive branch-and-bound (MORK slice S1b) would
prune low-gain branches before counting them. The brute-force version stays as the differential oracle.

## Flat interned atom core (Lever B)

The biggest remaining lever is **Lever B: a flat, interned atom core**, modeled on MORK's actual representation (`/home/user/Dev/mork-latest-linalg/kernel`, `mork::__mork_expr`): expressions encoded as a contiguous byte/int sequence with `Arity(n)` / `SymbolSize(k)+bytes` / `NewVar` / `VarRef(i)` tags, symbols interned to ids, stored in a PathMap radix trie. The payoff is large — `atomEq` becomes a byte compare, traversal is a cache-friendly linear scan, allocation collapses, and `getTypes`/match results become memoizable by id. The current profile's top costs (`mettaEval` allocation, `getTypes`, Map lookups) are exactly what it targets.

This is **not** a contained change: it rewrites the atom model and everything built on it (parser output, matcher, evaluator). The right gate is a passing 270/270 oracle and a clean before/after benchmark; without that baseline in place first, the change would destabilize the verified core. The six optimizations above are incremental wins that leave the current model intact; Lever B (and a staging/partial-evaluation backend, and a `mnemonist` AtomSpace index) go on top, with MORK's code as the reference implementation.
