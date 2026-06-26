// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// @metta-ts/das-client — Distributed AtomSpace as a pluggable Space backend for MeTTa TS.
//
// Architecture (shipped, mock-tested): `DasTransport` is the network boundary; `DasSpace`
// implements the kernel's `Space` interface over a transport, so DAS is just another Space backend.
//
// Live bus client (validated against a real 1.0.0 DAS): `queryPatternMatching` runs the full
// choreography — host an inbound proxy node, issue a `pattern_matching_query`, receive the streamed
// answer bundle, decode it. The query-token grammar (`query-tokens`) and the answer protocol
// (`answer`) are faithful to das-mono's PatternMatchingQueryProcessor and QueryAnswer::tokenize, and
// atom-handle hashing (`handle`) is byte-identical to the live AtomDB. Node-only (a browser cannot
// host an inbound bus node; the browser reaches DAS via @metta-ts/das-gateway). See README.
export { type DasTransport, MockTransport } from "./transport";
export { DasSpace } from "./das-space";
export { computeHash, namedTypeHash, terminalHash, compositeHash, expressionHash } from "./handle";
export { BusNode, BusCommand, type MessageHandler } from "./bus-node";
export { node, variable, expr, encodeQuery, type Pattern } from "./query-tokens";
export {
  parseQueryAnswer,
  collectAnswers,
  unwrapProxyMessage,
  type QueryAnswer,
  PROXY_COMMAND,
  ANSWER_BUNDLE,
  FINISHED,
  ABORT,
} from "./answer";
export {
  queryPatternMatching,
  type QueryOptions,
  type QueryResult,
} from "./query-client";
export {
  type AsyncSpace,
  DasLiveSpace,
  atomToPattern,
  matchAsync,
} from "./async-space";
