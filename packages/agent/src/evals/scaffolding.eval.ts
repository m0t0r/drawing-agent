import process from "node:process";

// Scaffolding, and the one thing worth checking before any golden case exists:
// that `pnpm eval` reaches the API key in the gitignored root `.env`. If this
// fails, every eval below it would fail for a reason that has nothing to do with
// the agent. Delete it once the golden cases land.
describe("eval environment", () => {
  it("has an OpenAI API key", () => {
    expect(process.env.OPENAI_API_KEY).toBeTruthy();
  });
});
