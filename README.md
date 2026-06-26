# MeTTa TS

A pure-TypeScript implementation of **MeTTa** (Meta Type Talk), the OpenCog Hyperon language. It runs anywhere TypeScript runs: the browser, Node, Deno, Bun, edge and serverless functions, and inside TypeScript-based AI agents. No native addons, no WASM, no Rust.

## Why this exists

Every other MeTTa implementation is tied to a runtime that cannot drop into a web page or a TypeScript agent without a native or WASM boundary: Rust (hyperon-experimental, MORK), Prolog (PeTTa, MeTTaLog), the JVM (JETTA), Python (the reference bindings). MeTTa TS fills the open lane. You import it and run, from a browser tab to a serverless handler to an agent loop. As more agent tooling is written in TypeScript, a MeTTa that lives natively in that ecosystem, with zero install steps and no build-time native step, is the point.

## Install

```bash
npm install @metta-ts/core        # the interpreter (works in any JS runtime)
# or: pnpm add @metta-ts/core  /  yarn add @metta-ts/core
```

Other packages, add as needed:

```bash
npm install @metta-ts/hyperon     # a Python-hyperon-style class API
npm install @metta-ts/node        # CLI + file import! + a parallel matcher
npm install @metta-ts/browser     # web entry + in-memory virtual file system
```

For the command-line runner, install `@metta-ts/node` globally (or use `npx`):

```bash
npm install -g @metta-ts/node
metta-ts path/to/program.metta

# without a global install:
npx -p @metta-ts/node metta-ts path/to/program.metta
```

## Quick start

Run MeTTa source from TypeScript with the core package:

```ts
import { runProgram, format } from "@metta-ts/core";

const results = runProgram(`
  (= (fact $n) (unify $n 0 1 (* $n (fact (- $n 1)))))
  !(fact 5)
`);

for (const { query, results: rs } of results) {
  console.log(format(query), "=>", rs.map(format));
}
// (fact 5) => [ '120' ]
```

`runProgram` parses the source, adds every non-bang atom to the knowledge base, evaluates each `!`-query, and returns one result group per query.

## Calling TypeScript from MeTTa

The `@metta-ts/hyperon` package is a class API modeled on Python's `hyperon`, but TypeScript-native: no Python, no Rust, no FFI. A grounded operation is a TypeScript function the evaluator can call by name.

```ts
import { MeTTa, ValueAtom, type GroundedAtom, type Atom } from "@metta-ts/hyperon";

const metta = new MeTTa();

metta.registerOperation("double", (args: Atom[]) => {
  const n = (args[0] as GroundedAtom).jsValue<number>();
  return [ValueAtom(n * 2)];
});

console.log(metta.run("!(double 21)")[0].map(String)); // [ '42' ]
```

A thrown error becomes a MeTTa `(Error ...)` atom the program can inspect, rather than crashing the run.

## Async MeTTa

MeTTa can be asynchronous. A grounded operation can do I/O (a fetch, a database query, a timer) and the evaluator awaits it. Register it with `registerAsyncOperation` and run with `runAsync`. A synchronous program gives identical results either way.

```ts
import { MeTTa, ValueAtom } from "@metta-ts/hyperon";

const metta = new MeTTa();
metta.registerAsyncOperation("fetch-temperature", async () => {
  const res = await fetch("https://example.com/temp"); // any real I/O
  return [ValueAtom(await res.json())];
});

const out = await metta.runAsync("!(fetch-temperature)");
console.log(out[0].map(String));
```

## Ergonomic typed eDSL

For writing MeTTa in idiomatic TypeScript, [`@metta-ts/edsl`](packages/edsl) gives typed term builders, special-form combinators (`iff`, `caseOf`, `matchSelf`, arithmetic, ...), and a tagged-template surface. It builds ordinary atoms and runs on the same engine, so you get MeTTa's real semantics (rewrite rules, nondeterminism, pattern matching) rather than a relational query language. Any TypeScript value drops in as a grounded atom automatically.

```ts
import { mettaDB, S, v, rel, iff, gt, lt, mul, sub, m, ValueAtom, type GroundedAtom } from "@metta-ts/edsl";

const db = mettaDB();

// Facts + a typed match query.
db.add(rel("Likes")(S.Ada, S.Coffee), rel("Likes")(S.Ada, S.Chocolate));
const thing = v<string>("thing");
db.query(rel("Likes")(S.Ada, thing), { thing }); // [{ thing: "Coffee" }, { thing: "Chocolate" }]

// Recursive rewrite rule + grounded arithmetic.
const x = v<number>("x");
db.rule(rel("fact")(x), iff(gt(x, 0), mul(x, rel("fact")(sub(x, 1))), 1));
db.evalJs(rel("fact")(5)); // [120]

// Pass a TypeScript object straight into a query (auto-grounded).
db.op("balance-of", (args) => [ValueAtom((args[0] as GroundedAtom).jsValue<{ balance: number }>().balance)]);
db.evalJs(rel("balance-of")({ owner: "Tom", balance: 100 })); // [100]
db.evalJs(m`(balance-of ${{ owner: "Tom", balance: 100 }})`); // [100] — template surface
```

More runnable examples are in [`examples/`](examples/): [`quickstart.ts`](examples/quickstart.ts), [`grounded-ops.ts`](examples/grounded-ops.ts), [`async.ts`](examples/async.ts), [`edsl.ts`](examples/edsl.ts), plus `.metta` source files. Run one with `npx tsx examples/quickstart.ts`.

## What is implemented

A faithful port of hyperon-experimental's minimal interpreter (the nondeterministic stack machine), with the standard library loaded as MeTTa source on top. The core passes **all 270 assertions** of Hyperon's oracle corpus: the full dependent-type tier (GADTs, dependent types, types-as-propositions), spaces and mutable state, nondeterminism, grounded operations, and documentation. Correctness is also cross-checked against [LeaTTa](https://github.com/MesTTo/LeaTTa), the machine-checked (Lean 4) MeTTa semantics, pinned to the same commit.

Beyond the core: transactions, async evaluation, concurrency primitives (`par`, `race`, `once`, `with-mutex`), clause indexing that scales matching to millions of atoms, a flat interned knowledge base with a worker-thread parallel matcher, and a JavaScript interop layer (`js-atom`, `js-dot`, `js-list`, `js-dict`) that calls into the host runtime directly.

The whole thing is pure TypeScript. The core builds to a single ESM bundle (~23 KB gzipped) that runs in Node and the browser with no native addon and no WASM.

```bash
pnpm install
pnpm build
pnpm test          # 270/270 Hyperon oracle gate + unit and property tests
node packages/node/dist/cli.js examples/factorial.metta
```

## Packages

| Package | What it is |
|---------|------------|
| [`@metta-ts/core`](packages/core) | The interpreter, parser, type system, and standard library. Zero platform dependencies. |
| [`@metta-ts/hyperon`](packages/hyperon) | A TypeScript class API over the core, modeled on Python's `hyperon`. |
| [`@metta-ts/edsl`](packages/edsl) | An ergonomic, typed eDSL: term builders, special-form combinators, and a tagged template. |
| [`@metta-ts/node`](packages/node) | The `metta-ts` CLI, file `import!`, and a `SharedArrayBuffer` worker-thread parallel matcher. |
| [`@metta-ts/browser`](packages/browser) | Browser entry point with an in-memory virtual file system for `import!`. |
| [`@metta-ts/das-client`](packages/das-client) | Optional client to SingularityNET's Distributed AtomSpace via a Connect gateway. |

## Performance

Pure TypeScript throughout, no escape to native code. The interpreter uses a precomputed-ground short-circuit, structural sharing in substitution, a cons-list instruction stack, and Prolog-style clause indexing (by head functor and by every ground-leaf argument position). A functor-and-argument-keyed query over a 1,000,000-atom knowledge base resolves in about 0.2 to 1.4 ms. See [`packages/node/bench/RESULTS.md`](packages/node/bench/RESULTS.md) for the full benchmark log.

## Provenance

- **Semantics:** [hyperon-experimental](https://github.com/trueagi-io/hyperon-experimental), pinned to commit `3f76dc4`.
- **Verified spec and differential oracle:** [LeaTTa](https://github.com/MesTTo/LeaTTa) (Lean 4).
- **Distributed AtomSpace:** optional client to SingularityNET DAS via a Connect gateway (Node), reachable from the browser.

## License

[MIT](LICENSE).
