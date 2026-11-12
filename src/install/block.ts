export const BEGIN = "<!-- istack:begin -->";
export const END = "<!-- istack:end -->";
const NOTE =
  "<!-- Written by `istack install`. Text between these markers is replaced on re-install and removed by `istack uninstall`; everything outside them is yours. -->";

/** The marked block, without a trailing newline. */
export function renderBlock(contract: string): string {
  return `${BEGIN}\n${NOTE}\n\n${contract.trimEnd()}\n${END}`;
}

export type BlockMerge =
  | { ok: true; text: string; prefix: string; replaced: boolean }
  | { ok: false; reason: string };

function locate(text: string): { start: number; end: number } | "none" | "broken" {
  const begins = text.split(BEGIN).length - 1;
  const ends = text.split(END).length - 1;
  if (begins === 0 && ends === 0) return "none";
  const start = text.indexOf(BEGIN);
  const endAt = text.indexOf(END);
  if (begins !== 1 || ends !== 1 || endAt < start) return "broken";
  return { start, end: endAt + END.length };
}

/**
 * Put the block into `existing` (null when the file is absent). An existing block is replaced in
 * place; otherwise the block is appended after a blank line. `prefix` is exactly what was added
 * before the block, so `removeBlock` can restore the file byte for byte.
 */
export function mergeBlock(existing: string | null, block: string, prefix: string): BlockMerge {
  const text = existing ?? "";
  const at = locate(text);
  if (at === "broken") {
    return { ok: false, reason: `has a broken ${BEGIN} … ${END} block; fix it by hand first` };
  }
  if (at !== "none") {
    return {
      ok: true,
      text: text.slice(0, at.start) + block + text.slice(at.end),
      prefix,
      replaced: true,
    };
  }
  const added = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { ok: true, text: `${text}${added}${block}\n`, prefix: added, replaced: false };
}

/** Remove the block and what the install added around it. Returns null when there is no block. */
export function removeBlock(text: string, prefix: string): string | null {
  const at = locate(text);
  if (at === "none" || at === "broken") return null;
  let before = text.slice(0, at.start);
  let after = text.slice(at.end);
  if (after.startsWith("\n")) after = after.slice(1);
  if (prefix && before.endsWith(prefix) && after === "") before = before.slice(0, -prefix.length);
  return before + after;
}
