// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// @metta-ts/node — Node adapters: file-backed import! and a program runner.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  type Atom,
  parseAll,
  standardTokenizer,
  evalSequential,
  collectImports,
  type QueryResult,
} from "@metta-ts/core";

/** Pre-read every `import!` target referenced in `src`, resolving names against `baseDir`. */
export function readImports(src: string, baseDir: string): Map<string, Atom[]> {
  const m = new Map<string, Atom[]>();
  for (const name of collectImports(src)) {
    const p = resolve(baseDir, name.endsWith(".metta") ? name : name + ".metta");
    if (existsSync(p))
      m.set(
        name,
        parseAll(readFileSync(p, "utf8"), standardTokenizer())
          .filter((t) => !t.bang)
          .map((t) => t.atom),
      );
  }
  return m;
}

/** Run a `.metta` file from disk, resolving `import!` relative to the file's directory. */
export function runFile(path: string, fuel?: number): QueryResult[] {
  const src = readFileSync(path, "utf8");
  const tops = parseAll(src, standardTokenizer());
  return evalSequential(tops, fuel, readImports(src, dirname(resolve(path))));
}

export * from "@metta-ts/core";
export { ParallelFlatMatcher } from "./flat-parallel";
