import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.mjs"],
    // Prevent hung API calls (real OpenRouter / DB) from stalling CI indefinitely.
    testTimeout: 30_000,   // 30s per individual test
    hookTimeout: 15_000,   // 15s for beforeAll / afterAll hooks
    coverage: {
      include: ["hooks/**", "server.mjs"],
    },
  },
});
