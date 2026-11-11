/**
 * GitHub adapter for the receipts check: reads the pull_request event and fetches the PR's changed
 * files and base-commit config with the read-only GITHUB_TOKEN. No other secrets, no LLM calls.
 * Every function reports failure as a value; none throws for an expected failure.
 */
import { OLD_CONFIG } from "../config/load.js";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** The slice of `fetch` the adapter uses, so tests can inject a fake without network. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

export interface PullRequestRef {
  repo: string;
  number: number;
  body: string;
  headSha: string;
  baseSha: string;
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Pull the fields the check needs out of a `pull_request` webhook payload. */
export function parsePullRequestEvent(event: unknown): Outcome<{ pr: PullRequestRef }> {
  const pr = isRecord(event) ? event.pull_request : undefined;
  const repo = isRecord(event) && isRecord(event.repository) ? event.repository.full_name : "";
  if (!isRecord(pr))
    return { ok: false, error: "the event has no pull_request; run on pull_request" };
  const head = isRecord(pr.head) ? pr.head.sha : undefined;
  const base = isRecord(pr.base) ? pr.base.sha : undefined;
  if (typeof pr.number !== "number" || typeof head !== "string" || typeof base !== "string") {
    return { ok: false, error: "the pull_request event is missing number, head.sha or base.sha" };
  }
  if (typeof repo !== "string" || !repo.includes("/")) {
    return { ok: false, error: "the event is missing repository.full_name" };
  }
  const body = typeof pr.body === "string" ? pr.body : "";
  return { ok: true, pr: { repo, number: pr.number, body, headSha: head, baseSha: base } };
}

interface ApiTarget {
  apiUrl: string;
  repo: string;
  token: string;
  fetch: FetchLike;
}

const PAGE_SIZE = 100;
/** GitHub's files endpoint stops at 3000 files (30 pages of 100). */
const MAX_PAGES = 30;

/** Every path a PR touches, paginated; a renamed file contributes both names. */
export async function fetchChangedFiles(
  target: ApiTarget & { number: number },
): Promise<Outcome<{ files: string[] }>> {
  const files: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${target.apiUrl}/repos/${target.repo}/pulls/${target.number}/files?per_page=${PAGE_SIZE}&page=${page}`;
    const got = await getText(target, url, "application/vnd.github+json");
    if (!got.ok) return got;
    const entries = parseJson(got.text);
    if (!Array.isArray(entries)) return { ok: false, error: `unexpected response from ${url}` };
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (typeof entry.filename === "string") files.push(entry.filename);
      if (typeof entry.previous_filename === "string") files.push(entry.previous_filename);
    }
    if (entries.length < PAGE_SIZE) break;
  }
  return { ok: true, files };
}

/** The raw text of istack.yaml at `ref`, or null when the repo has none. */
export async function fetchConfigText(
  target: ApiTarget & { ref: string; path?: string },
): Promise<Outcome<{ text: string | null }>> {
  const path = target.path ?? "istack.yaml";
  const url = `${target.apiUrl}/repos/${target.repo}/contents/${path}?ref=${target.ref}`;
  const got = await getText(target, url, "application/vnd.github.raw+json");
  if (got.ok) return { ok: true, text: got.text };
  if (got.status === 404 && target.path === undefined) {
    const oldUrl = `${target.apiUrl}/repos/${target.repo}/contents/mitchstack.yaml?ref=${target.ref}`;
    const old = await getText(target, oldUrl, "application/vnd.github.raw+json");
    if (old.ok) return { ok: false, error: `${OLD_CONFIG} at ${target.ref}` };
  }
  if (got.status === 404) return { ok: true, text: null };
  return { ok: false, error: got.error };
}

async function getText(
  target: ApiTarget,
  url: string,
  accept: string,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  try {
    const res = await target.fetch(url, {
      headers: {
        accept,
        authorization: `Bearer ${target.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "istack-receipts",
      },
    });
    const text = await res.text();
    if (res.ok) return { ok: true, text };
    return {
      ok: false,
      status: res.status,
      error: `GET ${url} → ${res.status}: ${text.slice(0, 200)}`,
    };
  } catch (error) {
    return { ok: false, status: 0, error: `GET ${url} failed: ${(error as Error).message}` };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
