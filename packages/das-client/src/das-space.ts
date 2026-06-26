// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A Space backed by a Distributed AtomSpace. It implements the same `Space` interface the kernel
// already injects (so it drops in wherever `InMemorySpace` does), delegating every operation to a
// `DasTransport`. This is how DAS becomes "just another Space backend".
import { type Atom, type Bindings, type Space } from "@metta-ts/core";
import { type DasTransport } from "./transport";

export class DasSpace implements Space {
  constructor(private readonly transport: DasTransport) {}
  add(atom: Atom): void {
    this.transport.add(atom);
  }
  remove(atom: Atom): boolean {
    return this.transport.remove(atom);
  }
  query(pattern: Atom): Bindings[] {
    return this.transport.query(pattern);
  }
  atoms(): readonly Atom[] {
    return this.transport.atoms();
  }
}
