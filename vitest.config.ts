import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "packages/subgraph/tests/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
