// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// @metta-ts/das-gateway — browser reach to DAS over HTTP.
//
// A browser cannot host an inbound DAS bus node, so it talks to a thin gateway that runs the Node
// `das-client` server-side and exposes request/response query over HTTP (Connect, which works over
// HTTP/1.1 and is browser-friendly). This module ships the wire shape and a Space that calls a
// gateway via an injected async transport; the Connect server/client and the live `das-client`
// behind it are the remaining integration (they need a running DAS — see README).
import { type Atom, type Bindings, format, parse, standardTokenizer } from "@metta-ts/core";

/** Gateway request/response, marshalled as MeTTa source strings across the wire. */
export interface QueryRequest {
  readonly space: string;
  readonly pattern: string;
}
export interface QueryResponse {
  /** Each solution as a flat list of `[varName, atomSource]` pairs. */
  readonly bindings: ReadonlyArray<ReadonlyArray<readonly [string, string]>>;
}

/** Encode/decode helpers so server and client agree on the wire format (MeTTa source strings). */
export const encodePattern = (a: Atom): string => format(a);
export const decodeBindings = (resp: QueryResponse): Bindings[] => {
  const tk = standardTokenizer();
  return resp.bindings.map((sol) =>
    sol.map(([x, src]) => ({ tag: "val" as const, x, a: parse(src, tk)!, y: undefined })),
  );
};

/** The async transport a browser uses to reach the gateway (e.g. a Connect-web client). */
export interface GatewayTransport {
  query(req: QueryRequest): Promise<QueryResponse>;
}

/** Browser-side async DAS access. Limitation: the kernel's `match` is synchronous but the gateway
 *  transport is async, so use this function directly rather than through `(match &das …)`. */
export async function queryDas(
  transport: GatewayTransport,
  space: string,
  pattern: Atom,
): Promise<Bindings[]> {
  return decodeBindings(await transport.query({ space, pattern: encodePattern(pattern) }));
}
