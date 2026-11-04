import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

export interface Viewport {
  width: number;
  height: number;
}

export interface CaptureOptions {
  /** Where to write the PNG. */
  out: string;
  viewport?: Viewport;
  deviceScaleFactor?: number;
  /** CSS selectors painted over with a solid box (dynamic regions: avatars, ads, random ids). */
  masks?: string[];
  /** The frozen `Date.now()` for the page, as an ISO string or epoch ms. */
  clock?: string | number;
  fullPage?: boolean;
  timeoutMs?: number;
}

/** Exactly one source: a URL (http(s) or file://) or an HTML string. */
export type CaptureInput = CaptureOptions & ({ url: string } | { html: string });

export type CaptureResult =
  | { ok: true; path: string; sha256: string }
  | { ok: false; reason: string };

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };
export const DEFAULT_CLOCK = "2026-01-01T00:00:00.000Z";
const MASK_COLOR = "#ff00ff";

interface Plan {
  source: { url: string } | { html: string };
  out: string;
  viewport: Viewport;
  deviceScaleFactor: number;
  masks: string[];
  clockMs: number;
  fullPage: boolean;
  timeoutMs: number;
}

/**
 * Take one deterministic headless screenshot and hash it. Fixed viewport and scale, CSS animations
 * and transitions stopped, caret hidden, reduced motion, `Date.now()` frozen, fixed locale and
 * timezone, waits for network idle and web fonts. Never throws.
 */
export async function capture(input: CaptureInput): Promise<CaptureResult> {
  const planned = planCapture(input);
  if (!planned.ok) return planned;
  const { plan } = planned;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const png = await shoot(browser, plan);
    mkdirSync(dirname(plan.out), { recursive: true });
    writeFileSync(plan.out, png);
    return { ok: true, path: plan.out, sha256: sha256(png) };
  } catch (error) {
    return { ok: false, reason: `capture failed: ${firstLine(error)}` };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function planCapture(
  input: CaptureInput,
): { ok: true; plan: Plan } | { ok: false; reason: string } {
  const hasUrl = typeof (input as { url?: unknown }).url === "string";
  const hasHtml = typeof (input as { html?: unknown }).html === "string";
  if (hasUrl === hasHtml) return { ok: false, reason: "give exactly one of url or html" };
  if (!input.out?.endsWith(".png")) return { ok: false, reason: "out must be a .png path" };
  const viewport = input.viewport ?? DEFAULT_VIEWPORT;
  if (!isPositiveInt(viewport.width) || !isPositiveInt(viewport.height)) {
    return { ok: false, reason: "viewport width and height must be positive integers" };
  }
  const deviceScaleFactor = input.deviceScaleFactor ?? 1;
  if (!(deviceScaleFactor > 0)) return { ok: false, reason: "deviceScaleFactor must be > 0" };
  const clockMs = new Date(input.clock ?? DEFAULT_CLOCK).getTime();
  if (Number.isNaN(clockMs)) return { ok: false, reason: "clock must be an ISO date or epoch ms" };
  const source = hasUrl
    ? { url: (input as { url: string }).url }
    : { html: (input as { html: string }).html };
  return {
    ok: true,
    plan: {
      source,
      out: input.out,
      viewport,
      deviceScaleFactor,
      masks: input.masks ?? [],
      clockMs,
      fullPage: input.fullPage ?? false,
      timeoutMs: input.timeoutMs ?? 30_000,
    },
  };
}

async function shoot(browser: Browser, plan: Plan): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: plan.viewport,
    deviceScaleFactor: plan.deviceScaleFactor,
    reducedMotion: "reduce",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(plan.timeoutMs);
    // Date.now()/new Date() are pinned; timers keep running so the app still renders.
    await page.clock.setFixedTime(plan.clockMs);
    await load(page, plan.source);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return await page.screenshot({
      type: "png",
      animations: "disabled",
      caret: "hide",
      scale: "device",
      fullPage: plan.fullPage,
      mask: plan.masks.map((selector) => page.locator(selector)),
      maskColor: MASK_COLOR,
    });
  } finally {
    await context.close();
  }
}

async function load(page: Page, source: Plan["source"]): Promise<void> {
  if ("html" in source) {
    await page.setContent(source.html, { waitUntil: "networkidle" });
    return;
  }
  const response = await page.goto(source.url, { waitUntil: "networkidle" });
  if (response && !response.ok()) throw new Error(`${source.url} answered ${response.status()}`);
}

function isPositiveInt(n: unknown): boolean {
  return Number.isInteger(n) && (n as number) > 0;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
