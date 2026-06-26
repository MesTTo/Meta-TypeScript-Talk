// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// S-expression parser and printer for the HE MeTTa grammar.
// Grammar: a program is atoms optionally prefixed by `!`. A word starting with `$` is a
// variable; `"..."` is a grounded String; `;` starts a line comment; words are run through
// the tokenizer and fall back to Symbol. `format` is the inverse printer.
import { type Atom, sym, variable, expr, gstr, isExpr, isVar, isSym, isGnd } from "./atom";
import { type Tokenizer } from "./tokenizer";

export interface TopAtom {
  readonly atom: Atom;
  readonly bang: boolean;
}

export const STRING_TYPE = sym("String");

const isWs = (c: string): boolean => /\s/.test(c);
const isDelim = (c: string): boolean => c === "(" || c === ")" || c === '"' || c === ";" || isWs(c);

class Cursor {
  pos = 0;
  constructor(
    readonly s: string,
    readonly tk: Tokenizer,
  ) {}
  done(): boolean {
    return this.pos >= this.s.length;
  }
  peek(): string {
    return this.s[this.pos] as string;
  }
  skipTrivia(): void {
    while (!this.done()) {
      const c = this.peek();
      if (isWs(c)) {
        this.pos++;
        continue;
      }
      if (c === ";") {
        while (!this.done() && this.peek() !== "\n") this.pos++;
        continue;
      }
      break;
    }
  }
}

function readString(c: Cursor): Atom {
  c.pos++; // opening quote
  let out = "";
  while (!c.done() && c.peek() !== '"') {
    if (c.peek() === "\\" && c.pos + 1 < c.s.length) {
      const next = c.s[c.pos + 1] as string;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      c.pos += 2;
      continue;
    }
    out += c.peek();
    c.pos++;
  }
  c.pos++; // closing quote
  return gstr(out);
}

function readWord(c: Cursor): string {
  let out = "";
  while (!c.done() && !isDelim(c.peek())) {
    out += c.peek();
    c.pos++;
  }
  return out;
}

function readAtom(c: Cursor): Atom {
  c.skipTrivia();
  const ch = c.peek();
  if (ch === "(") {
    c.pos++;
    const items: Atom[] = [];
    for (;;) {
      c.skipTrivia();
      if (c.done()) throw new Error("unbalanced '(' in MeTTa source");
      if (c.peek() === ")") {
        c.pos++;
        break;
      }
      items.push(readAtom(c));
    }
    return expr(items);
  }
  if (ch === '"') return readString(c);
  const word = readWord(c);
  if (word.startsWith("$")) return variable(word.slice(1));
  return c.tk.tokenize(word) ?? sym(word);
}

/** Parse the first top-level atom (with its `!`-flag), or undefined if the source is blank. */
export function parseTop(src: string, tk: Tokenizer): TopAtom | undefined {
  const c = new Cursor(src, tk);
  c.skipTrivia();
  if (c.done()) return undefined;
  let bang = false;
  if (c.peek() === "!") {
    bang = true;
    c.pos++;
    c.skipTrivia();
  }
  return { atom: readAtom(c), bang };
}

export function parse(src: string, tk: Tokenizer): Atom | undefined {
  return parseTop(src, tk)?.atom;
}

/** Parse a whole program into its sequence of top-level atoms. */
export function parseAll(src: string, tk: Tokenizer): TopAtom[] {
  const c = new Cursor(src, tk);
  const out: TopAtom[] = [];
  for (;;) {
    c.skipTrivia();
    if (c.done()) break;
    let bang = false;
    if (c.peek() === "!") {
      bang = true;
      c.pos++;
      c.skipTrivia();
    }
    out.push({ atom: readAtom(c), bang });
  }
  return out;
}

/** Print an atom back to MeTTa source (inverse of parse for normalized input). */
export function format(a: Atom): string {
  if (isExpr(a)) return "(" + a.items.map(format).join(" ") + ")";
  if (isVar(a)) return "$" + a.name;
  if (isSym(a)) return a.name;
  if (isGnd(a)) {
    const v = a.value;
    switch (v.g) {
      case "int":
        return String(v.n);
      case "float":
        return Number.isInteger(v.n) ? v.n.toFixed(1) : String(v.n);
      case "str":
        return JSON.stringify(v.s);
      case "bool":
        return v.b ? "True" : "False";
      case "unit":
        return "()";
      case "error":
        return v.msg;
      case "ext":
        return v.id;
    }
  }
  return "?";
}
