# @metta-ts/das-client

Distributed AtomSpace (DAS) as a pluggable `Space` backend for MeTTa TS.

## What ships here (real, tested)

- **gRPC stubs** generated from `singnet/das-proto` (`src/gen/`): `DistributedAlgorithmNode` (`ping`, `execute_message`), `attention_broker`, `MessageData{command, args, sender, …}`. Regenerate with `pnpm --filter @metta-ts/das-client gen` (needs `protoc`).
- **`BusNode`** — a real DAS bus node over those stubs: hosts an inbound gRPC server and sends `execute_message` to peers. Verified end-to-end in-process (two nodes exchange a `ping` and a `bus_command_proxy` command over the wire — no live DAS needed for that test).
- **Atom-handle hashing** (`handle.ts`) — a faithful port of `hyperon_das/hasher.py`, validated against independent **MD5 parity vectors** (a wrong handle makes every query miss, so this is the load-bearing piece).
- **`DasTransport` / `DasSpace`** — the Space-backend abstraction: `DasSpace` implements the kernel's `Space` interface over a transport, so a DAS drops in wherever `InMemorySpace` does. Mock-tested.
- **`MockTransport`** — an in-process transport exercising the exact `DasSpace` paths.
- **`das.metta`** — the vendored DAS module type declarations (`new-das!`, `das-evolution!`, …).
- The bus command vocabulary (`BusCommand`) read from the Python `service_bus`.

## Validated against a live DAS ✅

A real DAS cluster was stood up and the TypeScript client ran a full pattern-matching query over gRPC, end-to-end:

```bash
# 1.0.0 das-cli matches the released agent image; MongoDB 7.0 avoids the 8.x kernel guard.
pip install -e das-toolbox/das-cli   # at tag 1.0.0
das-cli config set                   # accept defaults
das-cli db start                     # Redis :40020 + MongoDB :40021 (use mongo:7.0)
das-cli metta load animals.metta
das-cli ab start                     # Attention Broker :40001
das-cli qa start                     # Query Agent :40002 (owns `pattern_matching_query`)

DAS_LIVE=1 pnpm vitest run packages/das-client/src/live-das.test.ts     # ping -> PING
DAS_LIVE=1 pnpm vitest run packages/das-client/src/live-query.test.ts   # the query below
```

The query test issues the official das integration query and decodes the answers:

```
(EVALUATION (PREDICATE "is_animal") (CONCEPT $C))
  -> monkey human triceratops earthworm chimp ent rhino snake   # all 8, byte-identical handles
```

**Version-matching is the catch.** The released 1.0.0 Query Agent serves the `dasproto.AtomSpaceNode` service; `das-proto` HEAD later renamed it to `DistributedAlgorithmNode`. Calling HEAD's contract returns gRPC `UNIMPLEMENTED`; generating from the pre-rename `atom_space_node.proto` makes the call land. So the client carries both generated contracts and the live path uses the one the running agent actually serves.

## The query path (done, validated)

`queryPatternMatching` runs the whole choreography against a live agent:

1. **Encode** the pattern as a prefix DAS token stream (`query-tokens.ts`) — `LINK_TEMPLATE`/`LINK`/`NODE`/`VARIABLE`/`ATOM`, matching das-mono's `PatternMatchingQueryProcessor::setup_query_tree` stack machine. A link with a variable inside is a `LINK_TEMPLATE`; a fully-ground one is a `LINK`.
2. **Issue** it as a `pattern_matching_query` with the `ServiceBus::issue_bus_command` framing (`[requestor_id, serial, proxy_node_id, numParams=0, context, numTokens, ...tokens]`), hosting an inbound proxy node so the agent can stream answers back.
3. **Decode** the streamed `answer_bundle` peer messages (`answer.ts`): unwrap `bus_command_proxy` (the inner command is the last arg), then parse each `QueryAnswer::tokenize` string into its variable assignment and matched handles. The released 1.0.0 agent emits a **flat** handle list, captured and pinned in an offline fixture test.

Atom-handle hashing (`handle.ts`) is byte-identical to the live AtomDB (verified node-by-node against MongoDB), which is what makes every handle in the query and every handle in the decoded answer line up. The encoder and decoder have offline unit tests (`query-tokens.test.ts`) built from a real captured answer, so the protocol stays covered even when no DAS is running.

Two notes carried from the live run: this KB stored string literals **quoted** (`(PREDICATE "is_animal")`), so leaf names keep their quotes; and the `$C` binding resolves to the matched `CONCEPT` **node** handle, not the enclosing `(CONCEPT …)` link.

**Node-only:** a participant hosts an inbound bus node, which a browser cannot do — the browser reaches DAS through [`@metta-ts/das-gateway`](../das-gateway).

## Kernel integration note

`DasSpace` implements the same `Space` interface as `InMemorySpace`. Wiring a named DAS-backed space into the interpreter's `World` (so `match`/`add-atom`/`get-atoms` over a `new-das!` handle dispatch to a `DasSpace`) is a small generalization of `World.spaces` from `Atom[]` lists to `Space` backends — the seam is already the `Space` interface.
