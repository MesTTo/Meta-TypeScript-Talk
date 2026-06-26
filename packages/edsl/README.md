# @metta-ts/edsl

An ergonomic, typed TypeScript eDSL for [MeTTa TS](https://github.com/MesTTo/metta-ts). Write MeTTa with typed term builders and special-form combinators, or a tagged-template surface, and run it on the real interpreter. Any TypeScript value drops in as a grounded atom automatically.

It is a thin layer over [`@metta-ts/hyperon`](https://github.com/MesTTo/metta-ts/tree/main/packages/hyperon): everything builds ordinary atoms and runs through the existing engine, so you get MeTTa's actual semantics (rewrite rules, nondeterminism, pattern matching, types), not a relational query language.

## Install

```bash
npm install @metta-ts/edsl
```

## Usage

```ts
import { mettaDB, S, v, rel, iff, gt, lt, mul, sub, m, ValueAtom, type GroundedAtom } from "@metta-ts/edsl";

const db = mettaDB();

// Facts + a typed match query (rows are typed by the variables).
db.add(rel("Likes")(S.Ada, S.Coffee), rel("Likes")(S.Ada, S.Chocolate));
const thing = v<string>("thing");
db.query(rel("Likes")(S.Ada, thing), { thing }); // [{ thing: "Coffee" }, { thing: "Chocolate" }]

// Rewrite rules + grounded arithmetic, recursion, nondeterminism.
const x = v<number>("x");
db.rule(rel("fact")(x), iff(gt(x, 0), mul(x, rel("fact")(sub(x, 1))), 1));
db.evalJs(rel("fact")(5)); // [120]

// Pass a TypeScript object straight in (auto-grounded), operated on by a TS function.
db.op("balance-of", (args) => [ValueAtom((args[0] as GroundedAtom).jsValue<{ balance: number }>().balance)]);
const account = { owner: "Tom", balance: 100 };
db.evalJs(rel("balance-of")(account)); // [100]
db.evalJs(m`(balance-of ${account})`); // [100] — same, via the template surface

// Async grounded ops, awaited.
db.asyncOp("fetch", async () => [ValueAtom(await getTemp())]);
await db.evalJsAsync(rel("fetch")());
```

## The two surfaces

- **Typed builders** for construction with static types: `S`/`v`/`e`/`rel`, `rule`/`decl`/`arrow`, the special forms `iff`/`caseOf`/`lett`/`letStar`/`matchSelf`/`superpose`/`collapse`/`empty`/`unify`, the grounded ops `add`/`sub`/`mul`/`div`/`mod`, `eq`/`gt`/`lt`/`ge`/`le`, `and`/`or`/`not`, `carAtom`/`cdrAtom`/`consAtom`, and `list`/`nil`. Builders compose, so nested patterns and repeated variables are just nested calls.
- **Tagged template** `m\`...\`` (and `mAll` for several atoms): the real parser, so it expresses every MeTTa form, and `${value}` auto-grounds (the easiest way to drop a TS object in).

## The runner

`mettaDB()` keeps MeTTa's two query mechanisms distinct: `query(pattern, vars)` does `match &self` over stored atoms and returns typed binding rows; `eval(atom)` (and `evalJs`, `evalAsync`, `evalJsAsync`) rewrites with the `=` rules and returns the nondeterministic results. `op`/`asyncOp` register TypeScript functions as grounded operations. `ground(x)` is the primitive behind auto-grounding.

## License

[MIT](https://github.com/MesTTo/metta-ts/blob/main/LICENSE).
