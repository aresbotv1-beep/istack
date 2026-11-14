import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeReceipts } from "../receipts/write.js";
import { capture, type Viewport } from "./capture.js";
import { runAndRecord } from "./run.js";

export interface CliIo {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = [
  "usage: istack prove capture --url <url> --out <file.png> [--viewport 1280x800] [--mask <selector>]...",
  "       istack prove receipts --from <claims.json>",
  "       istack prove run -- <command> [args...]",
].join("\n");

/** `args` are the words after `prove`. Returns the process exit code. */
export async function runProveCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === "run") return runRun(rest, io);
  const flags = parseFlags(rest);
  if (!flags.ok) return usage(io, flags.reason);
  if (command === "capture") return runCapture(flags.flags, io);
  if (command === "receipts") return runReceipts(flags.flags, io);
  return usage(io);
}

type Flags = Map<string, string[]>;

function parseFlags(words: string[]): { ok: true; flags: Flags } | { ok: false; reason: string } {
  const flags: Flags = new Map();
  for (let i = 0; i < words.length; i += 2) {
    const name = words[i] as string;
    const value = words[i + 1];
    if (!name.startsWith("--") || value === undefined || value.startsWith("--")) {
      return { ok: false, reason: `expected "--flag value", got "${name}"` };
    }
    flags.set(name.slice(2), [...(flags.get(name.slice(2)) ?? []), value]);
  }
  return { ok: true, flags };
}

function one(flags: Flags, name: string): string | undefined {
  return flags.get(name)?.at(-1);
}

function parseViewport(text: string): Viewport | undefined {
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function runCapture(flags: Flags, io: CliIo): Promise<number> {
  const url = one(flags, "url");
  const out = one(flags, "out");
  if (!url || !out) return usage(io, "capture needs --url and --out");
  const viewportText = one(flags, "viewport");
  const viewport = viewportText === undefined ? undefined : parseViewport(viewportText);
  if (viewportText !== undefined && !viewport) {
    return usage(io, `--viewport must look like 1280x800, got "${viewportText}"`);
  }
  const path = resolve(io.cwd, out);
  const result = await capture({ url, out: path, viewport, masks: flags.get("mask") ?? [] });
  if (!result.ok) {
    io.err(result.reason);
    return 1;
  }
  io.out(`${result.sha256}  ${result.path}`);
  return 0;
}

function runReceipts(flags: Flags, io: CliIo): number {
  const from = one(flags, "from");
  if (!from) return usage(io, "receipts needs --from <claims.json>");
  const path = resolve(io.cwd, from);
  if (!existsSync(path)) {
    io.err(`no claims file at ${path}`);
    return 1;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    io.err(`${path} is not valid JSON: ${(error as Error).message}`);
    return 1;
  }
  const result = writeReceipts(json);
  if (!result.ok) {
    io.err(`${path} does not make valid receipts:`);
    for (const e of result.errors) io.err(`  ${e.path || "(file)"}: ${e.message}`);
    return 1;
  }
  io.out(result.block);
  return 0;
}

function runRun(words: string[], io: CliIo): number {
  if (words[0] !== "--" || !words[1]) return usage(io, "run needs -- <command>");
  const result = runAndRecord(words.slice(1), io.cwd);
  if (!result.ok) return usage(io, result.reason);
  if (result.dirty) {
    io.err(`warning: uncommitted changes; this run is not exactly commit ${result.record.run.sha}`);
  }
  io.out(JSON.stringify(result.record, null, 2));
  return result.record.run.exitCode;
}

function usage(io: CliIo, reason?: string): number {
  if (reason) io.err(reason);
  io.err(USAGE);
  return 2;
}
