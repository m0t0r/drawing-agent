import { describe, expect, it } from "vitest";

// Scaffolding. It proves the runner executes TypeScript sources from this
// package and that `pnpm test` reaches them; it asserts nothing about the agent
// because the agent does not exist yet. Delete it once the loop tests land.
describe("test runner", () => {
  it("runs a TypeScript source file", () => {
    const answer: number = 21 * 2;

    expect(answer).toBe(42);
  });
});
