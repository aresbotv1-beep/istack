import { defineConfig } from "vitest/config";

/** Tests that launch headless Chromium (Playwright). `npm run test:browser`. */
export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts"],
  },
});
