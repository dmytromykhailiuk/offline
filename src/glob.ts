import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The pattern language of `offline.json` — Angular-PWA-style globs:
 *
 * - `**` matches across path segments (`"**.js"` → every `.js` file at any depth)
 * - `*` matches within one segment (`"/images/*.png"`, `"*-test-*"` as a dir name)
 * - `?` matches exactly one character within a segment (`"/icon-??.png"`)
 * - anything else is an exact path (`"/images/logo.png"`)
 *
 * Matched against posix-style paths with a leading `/`, relative to the
 * build directory. A pattern is rooted with a leading `/` unless it already
 * has one or starts with `**` (which may consume any number of segments).
 */
export const compilePattern = (pattern: string): RegExp => {
  const rooted = pattern.startsWith("/") || pattern.startsWith("**") ? pattern : `/${pattern}`;
  // Split on `**` first: the cross-segment wildcard must not be visible to
  // the per-part `*` translation, and joining with `.*` needs no placeholder.
  const source = rooted
    .split("**")
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]"),
    )
    .join(".*");
  return new RegExp(`^${source}$`);
};

/**
 * Build a predicate from a pattern list with Angular-PWA-style negation:
 * plain patterns include, a `!` prefix excludes. A file matches when it
 * matches at least one plain pattern and no `!` pattern.
 */
export const createMatcher = (patterns: string[]): ((file: string) => boolean) => {
  const includes: RegExp[] = [];
  const excludes: RegExp[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) excludes.push(compilePattern(pattern.slice(1)));
    else includes.push(compilePattern(pattern));
  }
  return (file) =>
    includes.some((regexp) => regexp.test(file)) && !excludes.some((regexp) => regexp.test(file));
};

/**
 * Every file under `dir`, recursively, as sorted posix paths with a leading
 * `/` — the shape the patterns, the worker and `critical-assets.json` use.
 */
export const walkFiles = async (dir: string): Promise<string[]> => {
  const collected: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          const relative = path.relative(dir, absolute).split(path.sep).join("/");
          collected.push(`/${relative}`);
        }
      }),
    );
  };
  await walk(dir);
  return collected.sort();
};
