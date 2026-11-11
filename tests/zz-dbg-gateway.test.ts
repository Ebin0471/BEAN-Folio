import { describe, expect, test } from "bun:test";
// Runs AFTER a file that captured+mocked the router — mirrors intelligence-gateway.
describe("dbg", () => {
  test("real registry call", async () => {
    console.log("A: importing registry", new Date().toISOString());
    const { providersFor } = await import("@/lib/intelligence/registry");
    console.log("B: registry imported", new Date().toISOString());
    const list = providersFor("image");
    console.log("C: providersFor done", list.length, new Date().toISOString());
    expect(list.length).toBeGreaterThan(0);
  }, 8000);
});
