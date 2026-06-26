// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The DAS transport boundary. A `DasTransport` speaks to a Distributed AtomSpace; the concrete
// bus implementation (gRPC generated from `das-proto`, choreography ported from the Python
// `hyperon_das` reference) plugs in here. This package ships the architecture + a deterministic
// `MockTransport` for tests; the live bus client is the remaining integration (it needs a running
// DAS service to validate, so it is not shipped unverified — see README).
import { type Atom, type Bindings, matchAtoms } from "@metta-ts/core";

export interface DasTransport {
  /** Pattern-matching query against the remote space; returns binding sets (DAS `query`). */
  query(pattern: Atom): Bindings[];
  /** Create/insert an atom (DAS `add_link` / atomdb write). */
  add(atom: Atom): void;
  /** Remove an atom. */
  remove(atom: Atom): boolean;
  /** Enumerate atoms (where the backend supports it). */
  atoms(): readonly Atom[];
}

/** An in-process transport over a local atom list, for tests and offline development. It exercises
 *  the exact `DasSpace`/grounded-op code paths a real bus client would, minus the network. */
export class MockTransport implements DasTransport {
  constructor(private readonly store: Atom[] = []) {}
  query(pattern: Atom): Bindings[] {
    const out: Bindings[] = [];
    for (const a of this.store) for (const b of matchAtoms(pattern, a)) out.push(b);
    return out;
  }
  add(atom: Atom): void {
    this.store.push(atom);
  }
  remove(atom: Atom): boolean {
    const i = this.store.findIndex((a) => JSON.stringify(a) === JSON.stringify(atom));
    if (i < 0) return false;
    this.store.splice(i, 1);
    return true;
  }
  atoms(): readonly Atom[] {
    return this.store;
  }
}
