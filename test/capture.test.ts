import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { capture } from "../src/capture/capture.js";

const fixture = (name: string) =>
  pathToFileURL(new URL(`./fixtures/capture/${name}`, import.meta.url).pathname).href;
const outDir = () => mkdtempSync(join(tmpdir(), "ms-capture-"));

describe("capture (headless, deterministic)", { timeout: 60_000 }, () => {
  it("an unchanged page with a running animation and a live clock hashes the same twice", async () => {
    const dir = outDir();
    const first = await capture({ url: fixture("page.html"), out: join(dir, "a.png") });
    const second = await capture({ url: fixture("page.html"), out: join(dir, "b.png") });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.sha256).toBe(first.sha256);
  });

  it("a deliberately changed page hashes differently", async () => {
    const dir = outDir();
    const before = await capture({ url: fixture("page.html"), out: join(dir, "before.png") });
    const after = await capture({ url: fixture("page-changed.html"), out: join(dir, "after.png") });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.sha256).not.toBe(before.sha256);
  });

  it("writes the PNG it hashed", async () => {
    const out = join(outDir(), "nested", "shot.png");
    const result = await capture({ html: "<h1>hello</h1>", out });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bytes = readFileSync(out);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.sha256);
    expect(result.path).toBe(out);
  });

  it("freezes the clock to the requested time", async () => {
    const html = `<p id="t"></p><script>document.getElementById("t").textContent = new Date().toISOString()</script>`;
    const dir = outDir();
    const a = await capture({ html, out: join(dir, "a.png"), clock: "2030-05-05T05:05:05Z" });
    const b = await capture({ html, out: join(dir, "b.png"), clock: "2030-05-05T05:05:05Z" });
    const c = await capture({ html, out: join(dir, "c.png"), clock: "2031-05-05T05:05:05Z" });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(b.sha256).toBe(a.sha256);
    expect(c.sha256).not.toBe(a.sha256);
  });

  it("masks a region that changes on every load", async () => {
    const html = `<h1>stable</h1><p id="rand"></p><script>document.getElementById("rand").textContent = Math.random()</script>`;
    const dir = outDir();
    const a = await capture({ html, out: join(dir, "a.png"), masks: ["#rand"] });
    const b = await capture({ html, out: join(dir, "b.png"), masks: ["#rand"] });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.sha256).toBe(a.sha256);
  });

  it("uses the viewport it was given", async () => {
    const result = await capture({
      html: "<p>x</p>",
      out: join(outDir(), "v.png"),
      viewport: { width: 320, height: 200 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const png = readFileSync(result.path);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([320, 200]);
  });

  it("refuses bad input with a reason instead of throwing", async () => {
    const out = join(outDir(), "x.png");
    expect(await capture({ out } as never)).toMatchObject({ ok: false });
    expect(await capture({ url: "x", html: "y", out } as never)).toMatchObject({ ok: false });
    expect(await capture({ html: "x", out, viewport: { width: 0, height: 10 } })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/viewport/),
    });
    expect(await capture({ html: "x", out: "shot.jpg" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/\.png/),
    });
    expect(await capture({ html: "x", out, clock: "not a date" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/clock/),
    });
  });

  it("reports an unreachable page as a failure", async () => {
    const result = await capture({
      url: pathToFileURL(join(outDir(), "missing.html")).href,
      out: join(outDir(), "m.png"),
    });
    expect(result).toMatchObject({ ok: false });
  });
});
