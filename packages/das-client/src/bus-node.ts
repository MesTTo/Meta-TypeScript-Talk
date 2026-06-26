// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A DAS bus node over the generated gRPC stubs (das-proto `DistributedAlgorithmNode`). This is the
// real wire layer the live transport is built on: a participant hosts an inbound node (a gRPC
// server) and sends `execute_message` commands to peers. The full pattern-matching choreography
// (the proxy that issues a `bus_command_proxy` and assembles the streamed `query_answer_tokens_flow`)
// is ported on top of this from the Python `hyperon_das` service_bus/proxy; this layer is what makes
// a node reachable and lets it ping/exchange messages. Node-only.
import {
  Server,
  ServerCredentials,
  credentials,
  type ServerUnaryCall,
  type sendUnaryData,
} from "@grpc/grpc-js";
import {
  DistributedAlgorithmNodeClient,
  DistributedAlgorithmNodeService,
  type MessageData,
} from "./gen/distributed_algorithm_node";
import { type Empty, type Ack } from "./gen/common";

/** The bus command vocabulary (from the Python/Rust clients' `service_bus`). */
export const BusCommand = {
  ping: "ping",
  ack: "ack",
  nodeJoinedNetwork: "node_joined_network",
  busCommandProxy: "bus_command_proxy",
  queryAnswerTokensFlow: "query_answer_tokens_flow",
} as const;

export type MessageHandler = (msg: MessageData) => void;

/** An inbound bus node: a gRPC server implementing `DistributedAlgorithmNode`, plus the ability to
 *  send `execute_message` to peers. */
export class BusNode {
  private server?: Server;
  constructor(
    readonly address: string,
    private readonly onMessage: MessageHandler = () => {},
  ) {}

  /** Start the inbound gRPC server. Resolves once it is listening. */
  start(): Promise<void> {
    const server = new Server();
    server.addService(DistributedAlgorithmNodeService, {
      ping: (_call: ServerUnaryCall<Empty, Ack>, cb: sendUnaryData<Ack>) =>
        cb(null, { error: false, msg: "pong" }),
      executeMessage: (call: ServerUnaryCall<MessageData, Empty>, cb: sendUnaryData<Empty>) => {
        this.onMessage(call.request);
        cb(null, {});
      },
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.bindAsync(this.address, ServerCredentials.createInsecure(), (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Send a command message to a peer node and await its acknowledgement. */
  send(peer: string, message: MessageData): Promise<void> {
    const client = new DistributedAlgorithmNodeClient(peer, credentials.createInsecure());
    return new Promise((resolve, reject) => {
      client.executeMessage(message, (err) => {
        client.close();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Ping a peer node; resolves with its `Ack`. */
  ping(peer: string): Promise<Ack> {
    const client = new DistributedAlgorithmNodeClient(peer, credentials.createInsecure());
    return new Promise((resolve, reject) => {
      client.ping({}, (err, ack) => {
        client.close();
        if (err) reject(err);
        else resolve(ack);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.tryShutdown(() => resolve());
    });
  }
}
