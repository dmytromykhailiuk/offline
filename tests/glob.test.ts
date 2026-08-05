// @vitest-environment node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilePattern, createMatcher, walkFiles } from "../src/glob";

describe("compilePattern()", () => {
  const matches = (pattern: string, file: string): boolean => compilePattern(pattern).test(file);

  it("matches ** across path segments", () => {
    expect(matches("**.js", "/main.js")).toBe(true);
    expect(matches("**.js", "/assets/chunks/vendor.js")).toBe(true);
    expect(matches("**.js", "/main.jsx")).toBe(false);
    expect(matches("**.js", "/main.css")).toBe(false);
  });

  it("matches * within a single segment", () => {
    expect(matches("/images/*.png", "/images/logo.png")).toBe(true);
    expect(matches("/images/*.png", "/images/nested/logo.png")).toBe(false);
  });

  it("matches exact paths verbatim", () => {
    expect(matches("/images/logo.png", "/images/logo.png")).toBe(true);
    expect(matches("/images/logo.png", "/images/logo2png")).toBe(false); // "." must stay literal
    expect(matches("/images/logo.png", "/images/logo.png.bak")).toBe(false);
  });

  it("roots patterns without a leading slash", () => {
    expect(matches("images/logo.png", "/images/logo.png")).toBe(true);
  });

  it("combines ** and * with literal parts", () => {
    expect(matches("**/fonts/*.woff2", "/assets/fonts/inter.woff2")).toBe(true);
    expect(matches("**/fonts/*.woff2", "/assets/fonts/sub/inter.woff2")).toBe(false);
  });

  it("roots single-star patterns so they match from the top level", () => {
    expect(matches("*-test-*/**.js", "/foo-test-bar/deep/x.js")).toBe(true);
    expect(matches("*-test-*/**.js", "/foo-test-bar/x.js")).toBe(true);
    expect(matches("*-test-*/**.js", "/nested/foo-test-bar/x.js")).toBe(false);
    expect(matches("*.js", "/main.js")).toBe(true);
    expect(matches("*.js", "/scripts/main.js")).toBe(false);
  });

  it("? matches exactly one character within a segment", () => {
    expect(matches("/icon-??.png", "/icon-72.png")).toBe(true);
    expect(matches("/icon-??.png", "/icon-728.png")).toBe(false);
    expect(matches("/icon-??.png", "/icon-7.png")).toBe(false);
    expect(matches("/a?b.css", "/a/b.css")).toBe(false); // never crosses a slash
  });
});

describe("createMatcher()", () => {
  it("combines includes with !-negated excludes", () => {
    const matcher = createMatcher(["**.js", "!vendor/**.js"]);
    expect(matcher("/app.js")).toBe(true);
    expect(matcher("/deep/app.js")).toBe(true);
    expect(matcher("/vendor/lib.js")).toBe(false);
    expect(matcher("/styles.css")).toBe(false);
  });

  it("excludes apply across every include pattern", () => {
    const matcher = createMatcher(["**.js", "**.css", "!**.min.*"]);
    expect(matcher("/a.js")).toBe(true);
    expect(matcher("/a.min.js")).toBe(false);
    expect(matcher("/b.min.css")).toBe(false);
  });

  it("a list of only excludes matches nothing", () => {
    const matcher = createMatcher(["!**.js"]);
    expect(matcher("/a.css")).toBe(false);
  });
});

describe("walkFiles()", () => {
  let dir: string;

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns every file as a sorted posix path with a leading slash", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "offline-glob-"));
    await fs.mkdir(path.join(dir, "nested", "deep"), { recursive: true });
    await fs.writeFile(path.join(dir, "b.js"), "");
    await fs.writeFile(path.join(dir, "a.css"), "");
    await fs.writeFile(path.join(dir, "nested", "deep", "c.svg"), "");
    await expect(walkFiles(dir)).resolves.toEqual(["/a.css", "/b.js", "/nested/deep/c.svg"]);
  });
});
