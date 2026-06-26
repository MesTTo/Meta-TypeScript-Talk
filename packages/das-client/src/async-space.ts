// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// An async Space backed by a live Distributed AtomSpace. A DAS query is a network round-trip, so it
// cannot sit behind the kernel's synchronous `Space.query`; this is the honest async boundary. The
// verified synchronous core is untouched — `AsyncSpace` is a parallel interface for remote backends,
// and `matchAsync` is the async analogue of a `(match space pattern template)`.
import {
  type Atom,
  type Bindings,
  addValRaw,
  emptyBindings,
  instantiate,
  parse,
  standardTokenizer,
} from "@metta-ts/core";
import { node, variable, expr, type Pattern } from "./query-tokens";
import { queryPatternMatching } from "./query-client";

/** A knowledge store queried asynchronously (a remote/distributed AtomSpace). */
export interface AsyncSpace {
  /** All binding sets under which `pattern` matches a stored atom. */
  queryAsync(pattern: Atom): Promise<Bindings[]>;
}

/** Escape a string for use as a quoted DAS `Symbol` node name (backslash and double-quote). */
function escapeDasString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Convert a core MeTTa atom into a DAS query pattern. Symbols become `Symbol` nodes; string values
 *  become quoted `Symbol` nodes (DAS stores `"foo"` as a symbol whose name carries the quotes);
 *  variables become DAS variables; expressions recurse. Throws on grounded kinds with no faithful DAS
 *  encoding (error/unit/ext) rather than emitting a misleading node. */
export function atomToPattern(a: Atom): Pattern {
  switch (a.kind) {
    case "sym":
      return node(a.name);
    case "var":
      return variable(a.name);
    case "expr":
      return expr(...a.items.map(atomToPattern));
    case "gnd": {
      const v = a.value;
      switch (v.g) {
        case "str":
          return node(`"${escapeDasString(v.s)}"`);
        case "int":
        case "float":
          return node(String(v.n));
        case "bool":
          return node(v.b ? "True" : "False");
        default:
          throw new Error(`atomToPattern: grounded value of kind '${v.g}' has no DAS query encoding`);
      }
    }
  }
}

const TK = standardTokenizer();

/** A live DAS-backed async space. Hosts a proxy node per query (the agent streams answers back to
 *  it) and resolves each variable binding to a concrete atom via the answer's MeTTa mapping. */
export class DasLiveSpace implements AsyncSpace {
  private readonly proxyHost: string;
  constructor(
    private readonly agentAddress: string,
    proxyHost = "127.0.0.1",
    private readonly timeoutMs = 8000,
  ) {
    // Accept a bare host or a legacy host:port; the port is ignored (each query binds its own).
    this.proxyHost = proxyHost.includes(":") ? proxyHost.slice(0, proxyHost.indexOf(":")) : proxyHost;
  }

  async queryAsync(pattern: Atom): Promise<Bindings[]> {
    const { answers, finished, aborted } = await queryPatternMatching({
      proxyHost: this.proxyHost,
      agentAddress: this.agentAddress,
      pattern: atomToPattern(pattern),
      populateMettaMapping: true,
      timeoutMs: this.timeoutMs,
    });
    if (aborted) throw new Error("DAS query aborted by the agent");
    if (!finished)
      throw new Error(`DAS query did not finish within ${this.timeoutMs}ms (incomplete results)`);
    return answers.map((ans) => {
      let b: Bindings = emptyBindings;
      for (const [label, handle] of Object.entries(ans.assignment)) {
        const text = ans.metta[handle];
        if (text === undefined)
          throw new Error(`DAS answer has no MeTTa text for $${label} (handle ${handle})`);
        const atom = parse(text, TK);
        if (atom === undefined)
          throw new Error(`DAS answer MeTTa text for $${label} did not parse: <${text}>`);
        b = addValRaw(b, label, atom);
      }
      return b;
    });
  }
}

/** Async analogue of `(match space pattern template)`: query the space, then instantiate `template`
 *  under each resulting binding. With no template, returns the raw binding sets' instantiations of
 *  `pattern` itself. */
export async function matchAsync(
  space: AsyncSpace,
  pattern: Atom,
  template: Atom = pattern,
): Promise<Atom[]> {
  const bindings = await space.queryAsync(pattern);
  return bindings.map((b) => instantiate(b, template));
}
