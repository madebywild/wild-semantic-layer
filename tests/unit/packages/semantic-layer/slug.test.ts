import { describe, expect, it } from "vitest";
import {
  slug as slugFn,
  toIsoDate as toIsoDateFn,
} from "../../../../packages/semantic-layer/src/vault.js";

describe("slug", () => {
  it("lowercases input", () => {
    expect(slugFn("Hello WORLD")).toBe("hello-world");
  });

  it("replaces spaces with hyphens", () => {
    expect(slugFn("a b c")).toBe("a-b-c");
  });

  it("strips special characters", () => {
    expect(slugFn("Hello, World!")).toBe("hello-world");
  });

  it("handles already-slugified input", () => {
    expect(slugFn("already-slugified")).toBe("already-slugified");
  });

  it("trims leading and trailing whitespace", () => {
    expect(slugFn("  hello  ")).toBe("hello");
  });

  it("collapses multiple spaces into a single hyphen", () => {
    expect(slugFn("a   b")).toBe("a-b");
  });

  it("handles empty string", () => {
    expect(slugFn("")).toBe("");
  });

  it("preserves hyphens", () => {
    expect(slugFn("my-variable")).toBe("my-variable");
  });

  it("preserves numbers", () => {
    expect(slugFn("version 2")).toBe("version-2");
  });

  it("strips emoji and unicode beyond alphanumerics", () => {
    // Emoji is stripped, leaving space which becomes a single hyphen
    expect(slugFn("hello 🎉 world")).toBe("hello-world");
  });
});

describe("toIsoDate", () => {
  it("passes through a valid ISO date string", () => {
    expect(toIsoDateFn("2026-05-13")).toBe("2026-05-13");
  });

  it("converts a Date to an ISO date string", () => {
    expect(toIsoDateFn(new Date("2026-05-13T12:00:00Z"))).toBe("2026-05-13");
  });

  it("handles Date at midnight UTC", () => {
    expect(toIsoDateFn(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });

  it("handles Date at end of day", () => {
    expect(toIsoDateFn(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });
});
