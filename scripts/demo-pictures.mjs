// Makes the README's demo pair from the real checker: `npm run build && node scripts/demo-pictures.mjs`.
// Runs `istack receipts check` on two sample pull requests (stale proof, honest proof), then
// renders each run's exact output and exit code to a page and captures it headlessly.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "ms-demo-"));
const cli = join(root, "dist/bin/istack.js");
const files = join(work, "files.txt");
writeFileSync(files, "src/settings/SaveButton.tsx\nsrc/settings/save.ts\n");

const cases = [
  { name: "receipts-fail", fixture: "stale-head.md", title: "Proof made on an older version of the change" },
  { name: "receipts-pass", fixture: "honest-visual.md", title: "Proof made on the change being merged" },
];

const env = { ...process.env };
for (const key of ["GITHUB_TOKEN", "GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT", "GITHUB_EVENT_PATH"]) delete env[key];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
mkdirSync(join(root, "assets/demo"), { recursive: true });

for (const c of cases) {
  const event = join(work, `${c.name}.json`);
  writeFileSync(
    event,
    JSON.stringify({
      repository: { full_name: "you/your-app" },
      pull_request: {
        number: 42,
        body: readFileSync(join(root, "test/fixtures/receipts", c.fixture), "utf8"),
        head: { sha: "3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a" },
        base: { sha: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d" },
      },
    }),
  );
  const run = spawnSync("node", [cli, "receipts", "check", "--event", event, "--files", files], {
    cwd: work,
    env,
    encoding: "utf8",
  });
  const output = `${run.stdout}${run.stderr}`
    .split("\n")
    .filter((line) => !line.includes("no istack.yaml found"))
    .join("\n")
    .trim();
  const ok = run.status === 0;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d1117;font:15px/1.5 ui-monospace,Menlo,monospace;color:#c9d1d9}
    .w{padding:28px 32px;width:836px}
    h1{font:600 17px/1.3 -apple-system,Helvetica,sans-serif;margin:0 0 6px;color:#f0f6fc}
    .s{font:14px -apple-system,Helvetica,sans-serif;margin:0 0 18px;color:${ok ? "#3fb950" : "#f85149"}}
    pre{margin:0;white-space:pre-wrap;word-break:break-all;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
    .p{color:#8b949e}</style>
    <div class="w"><h1>${esc(c.title)}</h1>
    <p class="s">${ok ? "✓ passes — the pull request can be merged" : "✗ fails — the pull request is blocked"} (exit code ${run.status})</p>
    <pre><span class="p">$ istack receipts check</span>\n${esc(output)}</pre></div>`;
  const page = join(work, `${c.name}.html`);
  writeFileSync(page, html);
  const out = join(root, "assets/demo", `${c.name}.png`);
  const shot = spawnSync(
    "node",
    [cli, "prove", "capture", "--url", `file://${page}`, "--out", out, "--viewport", "900x250"],
    { encoding: "utf8" },
  );
  if (shot.status !== 0) {
    console.error(shot.stderr);
    process.exit(1);
  }
  console.log(`${c.name}: check exit ${run.status}; ${shot.stdout.trim()}`);
}
