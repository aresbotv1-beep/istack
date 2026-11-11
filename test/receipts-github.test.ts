import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type FetchLike,
  fetchChangedFiles,
  fetchConfigText,
  parsePullRequestEvent,
} from "../src/receipts/github.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "receipts");
const event = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake fetch that answers from a URL → response table and records every call. */
function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const route = routes[url];
    if (!route) return { ok: false, status: 404, text: async () => "not found" };
    const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return { ok: route.status < 300, status: route.status, text: async () => text };
  };
  return { fetch, calls };
}

const API = "https://api.github.com";
const FILES = `${API}/repos/example/widgets/pulls/7/files?per_page=100`;

describe("parsePullRequestEvent", () => {
  it("reads body, head, base, number and repo from a pull_request event", () => {
    const result = parsePullRequestEvent(event("event-honest.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pr.number).toBe(7);
    expect(result.pr.repo).toBe("example/widgets");
    expect(result.pr.headSha).toBe("3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a");
    expect(result.pr.baseSha).toBe("65881ed884127d64ec923c1f37f1bd280b5e4e33");
    expect(result.pr.body).toMatch(/```receipts/);
  });

  it("treats a null body as empty", () => {
    const raw = event("event-honest.json") as { pull_request: { body: unknown } };
    raw.pull_request.body = null;
    const result = parsePullRequestEvent(raw);
    expect(result.ok && result.pr.body).toBe("");
  });

  it("rejects an event that is not a pull request", () => {
    const result = parsePullRequestEvent({ ref: "refs/heads/main", repository: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pull_request/);
  });
});

describe("fetchChangedFiles", () => {
  it("follows pagination and includes the old name of a renamed file", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "added",
    }));
    const { fetch, calls } = fakeFetch({
      [`${FILES}&page=1`]: { status: 200, body: page1 },
      [`${FILES}&page=2`]: {
        status: 200,
        body: [{ filename: "src/New.tsx", status: "renamed", previous_filename: "src/Old.tsx" }],
      },
    });
    const result = await fetchChangedFiles({
      apiUrl: API,
      repo: "example/widgets",
      number: 7,
      token: "t0k",
      fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(102);
    expect(result.files).toContain("src/Old.tsx");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.authorization).toBe("Bearer t0k");
  });

  it("reports an API failure instead of throwing", async () => {
    const { fetch } = fakeFetch({ [`${FILES}&page=1`]: { status: 403, body: "rate limited" } });
    const result = await fetchChangedFiles({
      apiUrl: API,
      repo: "example/widgets",
      number: 7,
      token: "t0k",
      fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/403/);
  });
});

describe("fetchConfigText", () => {
  const URL = `${API}/repos/example/widgets/contents/istack.yaml?ref=65881ed`;

  it("returns the raw file at the base commit", async () => {
    const { fetch, calls } = fakeFetch({ [URL]: { status: 200, body: "version: 1\n" } });
    const result = await fetchConfigText({
      apiUrl: API,
      repo: "example/widgets",
      ref: "65881ed",
      token: "t0k",
      fetch,
    });
    expect(result).toEqual({ ok: true, text: "version: 1\n" });
    expect(calls[0]?.headers.accept).toBe("application/vnd.github.raw+json");
  });

  it("returns null text when the repo has no istack.yaml", async () => {
    const { fetch } = fakeFetch({});
    const result = await fetchConfigText({
      apiUrl: API,
      repo: "example/widgets",
      ref: "65881ed",
      token: "t0k",
      fetch,
    });
    expect(result).toEqual({ ok: true, text: null });
  });

  it("refuses a base commit that still has only mitchstack.yaml", async () => {
    const OLD = `${API}/repos/example/widgets/contents/mitchstack.yaml?ref=65881ed`;
    const { fetch } = fakeFetch({ [OLD]: { status: 200, body: "version: 1\n" } });
    const result = await fetchConfigText({
      apiUrl: API,
      repo: "example/widgets",
      ref: "65881ed",
      token: "t0k",
      fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/found mitchstack\.yaml — rename it to istack\.yaml/);
  });
});
