// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

/**
 * The runtime API: spaces, tokenizer, parser, and the MeTTa runner, modeled on Hyperon's
 * `hyperon.base` and `hyperon.runner`. A TypeScript-native surface over `@metta-ts/core`.
 */
import * as core from "@metta-ts/core";
import { Atom } from "./atoms";
import { Bindings, BindingsSet } from "./bindings";

const DEFAULT_FUEL = 100_000;

/** A reference to a Space: a store of atoms that can be added to, queried, and substituted over. */
export class SpaceRef {
  constructor(readonly space: core.Space) {}

  /** Add an atom to the space. */
  addAtom(atom: Atom): void {
    this.space.add(atom.catom);
  }
  /** Python alias of {@link addAtom}. */
  add_atom(atom: Atom): void {
    this.addAtom(atom);
  }

  /** Remove an atom from the space; returns whether one was removed. */
  removeAtom(atom: Atom): boolean {
    return this.space.remove(atom.catom);
  }
  /** Python alias of {@link removeAtom}. */
  remove_atom(atom: Atom): boolean {
    return this.removeAtom(atom);
  }

  /** Every atom in the space. */
  getAtoms(): Atom[] {
    return this.space.atoms().map(Atom.fromCAtom);
  }
  /** Python alias of {@link getAtoms}. */
  get_atoms(): Atom[] {
    return this.getAtoms();
  }

  /** The number of atoms in the space. */
  atomCount(): number {
    return this.space.atoms().length;
  }
  /** Python alias of {@link atomCount}. */
  atom_count(): number {
    return this.atomCount();
  }

  /** Match a pattern against the space, returning the binding frames. */
  query(pattern: Atom): BindingsSet {
    return new BindingsSet(this.space.query(pattern.catom).map((b) => new Bindings(b)));
  }

  /** Match `pattern`, then instantiate `template` under each resulting binding. */
  subst(pattern: Atom, template: Atom): Atom[] {
    return this.space.query(pattern.catom).map((b) => Atom.fromCAtom(core.instantiate(b, template.catom)));
  }
}

/** A space implemented in memory (Hyperon `GroundingSpace`). */
export class GroundingSpace extends SpaceRef {
  constructor() {
    super(new core.InMemorySpace());
  }
}

/**
 * The core.Space a {@link MeTTa} runner exposes as its top-level space. Unlike a plain in-memory
 * space, its mutations flow into the interpreter: adding an atom here is exactly what `run` does for
 * a non-bang atom (it reaches the evaluator's knowledge base), and querying it sees the same atoms
 * the evaluator does. This is what makes `runner.space()` live rather than a disconnected mirror.
 */
class RunnerSpace implements core.Space {
  constructor(
    private readonly onAdd: (a: core.Atom) => void,
    private readonly onRemove: (a: core.Atom) => boolean,
    private readonly list: () => readonly core.Atom[],
  ) {}
  add(atom: core.Atom): void {
    this.onAdd(atom);
  }
  remove(atom: core.Atom): boolean {
    return this.onRemove(atom);
  }
  query(pattern: core.Atom, freshen?: (a: core.Atom) => core.Atom): core.Bindings[] {
    const out: core.Bindings[] = [];
    for (const a of this.list()) {
      const target = freshen ? freshen(a) : a;
      for (const b of core.matchAtoms(pattern, target)) out.push(b);
    }
    return out;
  }
  atoms(): readonly core.Atom[] {
    return this.list();
  }
}

/** Turns words and string literals into atoms via registered `(regex, constructor)` pairs. */
export class Tokenizer {
  constructor(readonly ctok: core.Tokenizer = new core.Tokenizer()) {}

  /** Register a token: text matching `regex` becomes the atom built by `constr`. */
  registerToken(regex: RegExp, constr: (token: string) => Atom): void {
    this.ctok.register(regex, (s) => constr(s).catom);
  }
  /** Python alias of {@link registerToken}. */
  register_token(regex: RegExp, constr: (token: string) => Atom): void {
    this.registerToken(regex, constr);
  }
}

/** Parses S-expression MeTTa text into atoms, using a {@link Tokenizer} for leaf tokens. */
export class SExprParser {
  constructor(private readonly text: string) {}

  /** Parse the first atom (Hyperon `parse`). */
  parse(tokenizer: Tokenizer): Atom | undefined {
    const a = core.parse(this.text, tokenizer.ctok);
    return a === undefined ? undefined : Atom.fromCAtom(a);
  }

  /** Parse every top-level atom. */
  parseAll(tokenizer: Tokenizer): Atom[] {
    return core.parseAll(this.text, tokenizer.ctok).map((t) => Atom.fromCAtom(t.atom));
  }
}

/**
 * The MeTTa runner: evaluate MeTTa programs, holding a knowledge base and grounding across calls
 * (REPL-style). Build it, `run` source, register custom tokens and grounded operations.
 */
export class MeTTa {
  private readonly gt: core.GroundingTable;
  private readonly tok: Tokenizer;
  private env: core.MinEnv;
  private st: core.St;
  // The single authoritative knowledge base (atoms added after the prelude). Both `run` and
  // `space()` mutate this, and the interpreter's `env` is kept in lock-step with it.
  private readonly kb: core.Atom[] = [];
  private readonly _space: SpaceRef;

  constructor() {
    this.gt = core.stdTable();
    this.tok = new Tokenizer(standardTokenizerC());
    this.env = core.buildEnv([...core.preludeAtoms(), ...core.stdlibAtoms()], this.gt);
    this.env.imports = core.withBuiltinModules();
    this.st = core.initSt();
    this._space = new SpaceRef(
      new RunnerSpace(
        (a) => this.addToKb(a),
        (a) => this.removeFromKb(a),
        () => this.kb,
      ),
    );
  }

  // Add an atom to the KB and the interpreter env together.
  private addToKb(atom: core.Atom): void {
    this.kb.push(atom);
    core.addAtomToEnv(this.env, atom);
  }

  // Remove an atom from the KB; rebuild env from the prelude + remaining KB so retraction is real
  // (the env's rule/type indexes are derived, not incrementally removable).
  private removeFromKb(atom: core.Atom): boolean {
    const i = this.kb.findIndex((a) => core.atomEq(a, atom));
    if (i < 0) return false;
    this.kb.splice(i, 1);
    this.env = core.buildEnv([...core.preludeAtoms(), ...core.stdlibAtoms(), ...this.kb], this.gt);
    this.env.imports = core.withBuiltinModules();
    return true;
  }

  /** Run MeTTa source. Non-bang atoms extend the knowledge base; each `!`-query yields its results.
   *  Returns one atom list per `!`-query, in order. */
  run(program: string, fuel = DEFAULT_FUEL): Atom[][] {
    const parsed = core.parseAll(program, this.tok.ctok);
    const out: Atom[][] = [];
    for (const { atom, bang } of parsed) {
      if (!bang) {
        this.addToKb(atom);
        continue;
      }
      const [pairs, st2] = core.mettaEval(this.env, fuel, this.st, [], atom);
      this.st = st2;
      out.push(pairs.map((p) => Atom.fromCAtom(p[0])));
    }
    return out;
  }

  /** Run MeTTa source asynchronously, awaiting any async grounded operations (registered with
   *  {@link registerAsyncOperation}). Identical to {@link run} for a program with no async ops. */
  async runAsync(program: string, fuel = DEFAULT_FUEL): Promise<Atom[][]> {
    const parsed = core.parseAll(program, this.tok.ctok);
    const out: Atom[][] = [];
    for (const { atom, bang } of parsed) {
      if (!bang) {
        this.addToKb(atom);
        continue;
      }
      const [pairs, st2] = await core.mettaEvalAsync(this.env, fuel, this.st, [], atom);
      this.st = st2;
      out.push(pairs.map((p) => Atom.fromCAtom(p[0])));
    }
    return out;
  }

  /** Register an async grounded operation callable from MeTTa source by `name` (resolved by the async
   *  runner). The function receives the argument atoms and resolves to the result atoms. A rejection
   *  becomes a MeTTa `(Error ...)` atom. Use this for I/O — fetch, a DAS query, a timer. */
  registerAsyncOperation(name: string, op: (args: Atom[]) => Promise<Atom[]>): void {
    this.env.agt.set(name, async (args) => {
      try {
        const results = await op(args.map(Atom.fromCAtom));
        return { tag: "ok", results: results.map((a) => a.catom) };
      } catch (e) {
        return { tag: "runtimeError", msg: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /** Parse every top-level atom of a program. */
  parseAll(program: string): Atom[] {
    return core.parseAll(program, this.tok.ctok).map((t) => Atom.fromCAtom(t.atom));
  }

  /** Parse the first atom of a program. */
  parseSingle(program: string): Atom | undefined {
    const a = core.parse(program, this.tok.ctok);
    return a === undefined ? undefined : Atom.fromCAtom(a);
  }

  /** Evaluate a single atom against the runner's knowledge base (Hyperon `evaluate_atom`); returns its
   *  results. Unlike `run`, it takes an atom rather than source text. */
  evaluateAtom(atom: Atom, fuel = DEFAULT_FUEL): Atom[] {
    const [pairs, st2] = core.mettaEval(this.env, fuel, this.st, [], atom.catom);
    this.st = st2;
    return pairs.map((p) => Atom.fromCAtom(p[0]));
  }
  /** Python alias of {@link evaluateAtom}. */
  evaluate_atom(atom: Atom, fuel = DEFAULT_FUEL): Atom[] {
    return this.evaluateAtom(atom, fuel);
  }

  /** Evaluate a single atom, awaiting any async grounded operations reached during evaluation (those
   *  registered with {@link registerAsyncOperation}). Identical to {@link evaluateAtom} for a purely
   *  synchronous evaluation. */
  async evaluateAtomAsync(atom: Atom, fuel = DEFAULT_FUEL): Promise<Atom[]> {
    const [pairs, st2] = await core.mettaEvalAsync(this.env, fuel, this.st, [], atom.catom);
    this.st = st2;
    return pairs.map((p) => Atom.fromCAtom(p[0]));
  }

  /** The runner's top-level space. This is live: atoms added through it reach the evaluator's
   *  knowledge base (just as a non-bang atom in `run` does), and querying it sees what the evaluator
   *  sees. Removing an atom retracts it from evaluation too. */
  space(): SpaceRef {
    return this._space;
  }

  /** The runner's tokenizer. */
  tokenizer(): Tokenizer {
    return this.tok;
  }

  /** Register a custom token (text matching `regex` becomes `constr`'s atom). */
  registerToken(regex: RegExp, constr: (token: string) => Atom): void {
    this.tok.registerToken(regex, constr);
  }

  /** Register a symbol as a token that produces a fixed atom. */
  registerAtom(name: string, atom: Atom): void {
    this.tok.registerToken(new RegExp(`^${escapeRegExp(name)}$`), () => atom);
  }

  /** Register a grounded operation callable from MeTTa source by `name`. The function receives the
   *  argument atoms and returns the result atoms. A thrown error becomes a MeTTa `(Error ...)` atom
   *  (a hard, visible error the program can still inspect), rather than crashing the run. To instead
   *  leave the expression unevaluated so other rewrite rules can try (MeTTa's multiple dispatch on a
   *  type mismatch), throw {@link IncorrectArgumentError}. */
  registerOperation(name: string, op: (args: Atom[]) => Atom[]): void {
    this.gt.set(name, (args) => {
      try {
        return { tag: "ok", results: op(args.map(Atom.fromCAtom)).map((a) => a.catom) };
      } catch (e) {
        if (e instanceof IncorrectArgumentError) return { tag: "incorrectArgument", msg: e.message };
        return { tag: "runtimeError", msg: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /** Every type the runner infers for an atom (Hyperon `get_atom_types`). */
  getAtomTypes(atom: Atom): Atom[] {
    return core.getTypes(this.env, atom.catom).map(Atom.fromCAtom);
  }
  /** Python alias of {@link getAtomTypes}. */
  get_atom_types(atom: Atom): Atom[] {
    return this.getAtomTypes(atom);
  }
}

/** Throw this from a {@link MeTTa.registerOperation} handler to signal "wrong arguments for me, leave
 *  the expression unevaluated so other rules can match" (the core's `incorrectArgument`), instead of
 *  producing a hard `(Error ...)` atom. */
export class IncorrectArgumentError extends Error {}

/** The MeTTa standard tokenizer as a wrapped {@link Tokenizer} (integers, floats, `True`/`False`). */
export function standardTokenizer(): Tokenizer {
  return new Tokenizer(standardTokenizerC());
}

function standardTokenizerC(): core.Tokenizer {
  return core.standardTokenizer();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
