import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/server.js";

describe("parseDuration", () => {
  it("should parse seconds", () => {
    assert.strictEqual(parseDuration("30s"), 30_000);
    assert.strictEqual(parseDuration("1s"), 1_000);
    assert.strictEqual(parseDuration("5s"), 5_000);
  });

  it("should parse milliseconds", () => {
    assert.strictEqual(parseDuration("500ms"), 500);
    assert.strictEqual(parseDuration("100ms"), 100);
  });

  it("should parse minutes", () => {
    assert.strictEqual(parseDuration("1m"), 60_000);
    assert.strictEqual(parseDuration("5m"), 300_000);
  });

  it("should throw on invalid format", () => {
    assert.throws(() => parseDuration("30"), /Invalid duration/);
    assert.throws(() => parseDuration("abc"), /Invalid duration/);
    assert.throws(() => parseDuration(""), /Invalid duration/);
    assert.throws(() => parseDuration("30h"), /Invalid duration/);
  });
});
