#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// MeTTa TS command-line runner: `metta-ts <file.metta>` prints each !-query's results.
import { parseArgs } from "node:util";
import { format } from "@metta-ts/core";
import { runFile } from "./index";

function main(): void {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const file = positionals[0];
  if (file === undefined) {
    process.stderr.write("usage: metta-ts <file.metta>\n");
    process.exit(2);
  }
  for (const r of runFile(file)) {
    process.stdout.write("[" + r.results.map(format).join(", ") + "]\n");
  }
}

main();
