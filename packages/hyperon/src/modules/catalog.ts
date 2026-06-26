// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

/**
 * The module catalog, modeled on hyperon-experimental's catalog operations. A {@link ModuleCatalog}
 * is an in-memory registry of named catalogs, each holding module names; the operations manage it:
 *
 * - `catalog-clear!`  `(-> Symbol (->))` — clear one catalog, or `all`.
 * - `catalog-list!`   `(-> Symbol (->))` — record the contents of one catalog, or `all`.
 * - `catalog-update!` `(-> Symbol (->))` — mark one catalog updated, or `all`.
 *
 * Each returns the unit atom `()`. The real Hyperon catalogs fetch remote modules; this is the
 * TypeScript-native, dependency-free analogue (a registry you populate yourself), so it runs in a
 * browser with no filesystem or network.
 */
import { Atom, E } from "../atoms";
import { MeTTa } from "../base";

const ALL = "all";

/** An in-memory registry of named module catalogs. */
export class ModuleCatalog {
  private readonly catalogs = new Map<string, string[]>();
  /** A line per `catalog-list!` call, so the side effect is observable in tests/UIs. */
  readonly listing: string[] = [];
  /** The names of catalogs updated by `catalog-update!`. */
  readonly updated: string[] = [];

  /** Add or replace a named catalog's module list. */
  register(name: string, modules: string[]): void {
    this.catalogs.set(name, [...modules]);
  }

  /** The module names in a catalog. */
  modules(name: string): string[] {
    return this.catalogs.get(name) ?? [];
  }

  /** The catalog names, in insertion order. */
  names(): string[] {
    return [...this.catalogs.keys()];
  }

  private targets(target: string): string[] {
    return target === ALL ? this.names() : [target];
  }

  /** Clear one catalog (or `all`). */
  clear(target: string): void {
    for (const name of this.targets(target)) this.catalogs.set(name, []);
  }

  /** Record the contents of one catalog (or `all`) into {@link listing}. */
  list(target: string): void {
    for (const name of this.targets(target)) this.listing.push(`${name}: ${this.modules(name).join(", ")}`);
  }

  /** Mark one catalog (or `all`) updated. */
  update(target: string): void {
    for (const name of this.targets(target)) this.updated.push(name);
  }
}

const UNIT: Atom = E();

/** The Symbol argument's name, defaulting to `all`. */
function target(args: readonly Atom[]): string {
  const a = args[0];
  return a !== undefined && a.metatype() === "Symbol" ? a.toString() : ALL;
}

/** Register the catalog operations on a runner, backed by the given catalog. */
export function registerCatalogModule(m: MeTTa, catalog: ModuleCatalog): void {
  m.registerOperation("catalog-clear!", (args) => {
    catalog.clear(target(args));
    return [UNIT];
  });
  m.registerOperation("catalog-list!", (args) => {
    catalog.list(target(args));
    return [UNIT];
  });
  m.registerOperation("catalog-update!", (args) => {
    catalog.update(target(args));
    return [UNIT];
  });
}
