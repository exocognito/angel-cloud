import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { headingSlugs as sharedHeadingSlugs } from "./markdown-slugs";

/**
 * Contract for the public docs site (issue #4).
 *
 * The site's promise is that an agent holding only the docs URL can walk the
 * whole first-Angel journey. That breaks silently when a doc the index links
 * is missing from the build, when a canonical URL in llms.txt / SKILL.md
 * points at a path the worker does not serve, or when a cross-doc anchor
 * drifts after a heading edit. These tests build the real artifact with
 * build.sh and assert those invariants on the output.
 */

const repoRoot = join(import.meta.dir, "../..");
const buildScript = join(repoRoot, "docs-site/build.sh");
const CANONICAL_BASE = "https://docs.angelmcp.ai";
const INTERIM_BASE = "https://angelmcp-docs-demo.sam-633.workers.dev";
const CANONICAL_LEDGER_SOURCE = "https://github.com/exocognito/angelmcp/blob/main/docs/product-ledger.html";

// Every path the built site must serve. llms.txt and SKILL.md URL checks below
// resolve against this same set, so the list cannot drift from the assertions.
const SERVED_FILES = [
  "index.html",
  "styles.css",
  "viewer.js",
  "llms.txt",
  "SKILL.md",
  "user-manual.md",
  "faq.md",
  "operator-journey.md",
  "google-read-proof-manual-journey.md",
  "domain-architecture.md",
  // The public demo is a directory, not a file: llms.txt links /demo/, and
  // build.sh writes dist/demo/index.html plus the shell it is assembled from.
  "demo/",
];

let canonicalDist: string;
let interimDist: string;

beforeAll(() => {
  canonicalDist = mkdtempSync(join(tmpdir(), "docs-dist-canonical-"));
  interimDist = mkdtempSync(join(tmpdir(), "docs-dist-interim-"));
  execFileSync(buildScript, { env: { ...process.env, DOCS_DIST: canonicalDist } });
  execFileSync(buildScript, {
    env: { ...process.env, DOCS_DIST: interimDist, DOCS_BASE_URL: INTERIM_BASE },
  });
});

const read = (dist: string, file: string) => readFileSync(join(dist, file), "utf8");

// GitHub-style heading slug, mirroring docs-site/public/viewer.js `slugify`
// (which mirrors GitHub): lowercase, strip punctuation, spaces to hyphens,
// repeated hyphens NOT collapsed, duplicates suffixed -1, -2, ...
function headingSlugs(markdown: string): Set<string> {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return sharedHeadingSlugs(body, 4);
}

// Every canonical docs URL in a file, as { path, anchor } pairs.
function docLinks(content: string, base: string): Array<{ path: string; anchor: string | null }> {
  const links: Array<{ path: string; anchor: string | null }> = [];
  const re = new RegExp(`${base.replace(/[/.]/g, "\\$&")}(/[^\\s)"'\`<>]*)?`, "g");
  for (const m of content.matchAll(re)) {
    const rest = m[1] ?? "/";
    const [path = "", ...anchorParts] = rest.split("#");
    links.push({
      path: path.replace(/^\//, ""),
      anchor: anchorParts.length ? anchorParts.join("#") : null,
    });
  }
  return links;
}

describe("docs-site build output", () => {
  test("serves every file the journey depends on", () => {
    for (const file of SERVED_FILES) {
      const target = file === "demo/" ? "demo/index.html" : file;
      expect(existsSync(join(canonicalDist, target))).toBe(true);
    }
    // The user manual's images ship alongside it.
    expect(existsSync(join(canonicalDist, "manual-images"))).toBe(true);
  });

  test("served markdown is the repo markdown, verbatim", () => {
    const pairs: Array<[string, string]> = [
      ["docs/user-manual.md", "user-manual.md"],
      ["docs/faq.md", "faq.md"],
      ["docs/domain-architecture.md", "domain-architecture.md"],
      ["docs/google-read-proof-manual-journey.md", "operator-journey.md"],
      ["docs/google-read-proof-manual-journey.md", "google-read-proof-manual-journey.md"],
    ];
    for (const [source, served] of pairs) {
      expect(read(canonicalDist, served)).toBe(readFileSync(join(repoRoot, source), "utf8"));
    }
  });

  test("SKILL.md carries loadable skill frontmatter", () => {
    const skill = read(canonicalDist, "SKILL.md");
    const fm = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    expect(fm).not.toBeNull();
    expect(fm![1]).toMatch(/^name:\s*\S+/m);
    expect(fm![1]).toMatch(/^description:/m);
  });

  test("every canonical URL in llms.txt and SKILL.md resolves to a served file", () => {
    for (const file of ["llms.txt", "SKILL.md"]) {
      const links = docLinks(read(canonicalDist, file), CANONICAL_BASE);
      expect(links.length).toBeGreaterThan(0);
      for (const { path } of links) {
        if (path === "") continue; // the bare host is the index
        expect(SERVED_FILES).toContain(path);
      }
    }
  });

  test("every cross-doc anchor in llms.txt and SKILL.md exists in its target doc", () => {
    const slugCache = new Map<string, Set<string>>();
    const slugsOf = (path: string) => {
      let s = slugCache.get(path);
      if (!s) { s = headingSlugs(read(canonicalDist, path)); slugCache.set(path, s); }
      return s;
    };
    for (const file of ["llms.txt", "SKILL.md"]) {
      for (const { path, anchor } of docLinks(read(canonicalDist, file), CANONICAL_BASE)) {
        if (!anchor || !path.endsWith(".md")) continue;
        expect(slugsOf(path).has(anchor)).toBe(true);
      }
    }
  });

  test("every relative link in every served markdown file resolves, anchors included", () => {
    // Crawl the whole served set: root docs plus the decision-record
    // directories they link into. A dangling relative link is exactly the
    // defect that turns a public docs walk into a dead end.
    const servedMarkdown: string[] = [
      ...SERVED_FILES.filter((f) => f.endsWith(".md")),
      ...readdirSync(join(canonicalDist, "product-decisions")).map((f) => `product-decisions/${f}`),
      ...readdirSync(join(canonicalDist, "adrs")).map((f) => `adrs/${f}`),
      ...readdirSync(join(canonicalDist, "core")).map((f) => `core/${f}`),
    ];
    expect(servedMarkdown.some((f) => f.startsWith("product-decisions/"))).toBe(true);
    expect(servedMarkdown.some((f) => f.startsWith("adrs/"))).toBe(true);
    expect(servedMarkdown.some((f) => f.startsWith("core/"))).toBe(true);

    const slugCache = new Map<string, Set<string>>();
    const slugsOf = (path: string) => {
      let s = slugCache.get(path);
      if (!s) { s = headingSlugs(read(canonicalDist, path)); slugCache.set(path, s); }
      return s;
    };

    for (const file of servedMarkdown) {
      const body = read(canonicalDist, file).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
      for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1] ?? "";
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [rawPath = "", ...anchorParts] = href.split("#");
        const anchor = anchorParts.length ? anchorParts.join("#") : null;
        const target = rawPath === "" ? file : normalize(join(dirname(file), rawPath));
        expect(
          existsSync(join(canonicalDist, target)),
          `${file} links ${href} but ${target} is not served`,
        ).toBe(true);
        if (anchor && target.endsWith(".md")) {
          expect(
            slugsOf(target).has(anchor),
            `${file} links ${href} but ${target} has no heading #${anchor}`,
          ).toBe(true);
        }
      }
    }
    // Regression for the slug mirror: a code-span heading keeps its underscore
    // (faq.md's angel_connection question), so the crawl above genuinely
    // exercises underscore anchors rather than passing vacuously.
    expect(slugsOf("faq.md").has("can-i-declare-or-guard-angel_connection-in-my-own-policy")).toBe(true);
  });

  test("served markdown never links a served doc through the GitHub repo", () => {
    // A same-repo blob link sends a reader from the public site back to the
    // source tree — the workflow this site exists to end. Issue-tracker links
    // are fine; doc files must use relative links so they resolve on the site.
    // The self-contained Product Ledger is canonical repo truth, not a docs-site file.
    const servedMarkdown = [
      ...SERVED_FILES.filter((f) => f.endsWith(".md")),
      ...readdirSync(join(canonicalDist, "product-decisions")).map((f) => `product-decisions/${f}`),
      ...readdirSync(join(canonicalDist, "adrs")).map((f) => `adrs/${f}`),
      ...readdirSync(join(canonicalDist, "core")).map((f) => `core/${f}`),
    ];
    for (const file of servedMarkdown) {
      const content = read(canonicalDist, file).replaceAll(CANONICAL_LEDGER_SOURCE, "");
      expect(
        content,
        `${file} links repo files via github.com; use relative links`,
      ).not.toMatch(/github\.com\/exocognito\/angel(?:-cloud|mcp)\/(blob|tree|raw)\//);
    }
  });

  test("interim build rewrites the canonical base URL everywhere agents read", () => {
    for (const file of ["llms.txt", "SKILL.md"]) {
      const content = read(interimDist, file);
      expect(content).not.toContain(CANONICAL_BASE);
      expect(content).toContain(INTERIM_BASE);
    }
    // The rewrite touches only the two agent files; served docs stay verbatim.
    expect(read(interimDist, "user-manual.md")).toBe(read(canonicalDist, "user-manual.md"));
  });

  test("the index page links the agent files and every doc route", () => {
    const index = read(canonicalDist, "index.html");
    for (const href of ["SKILL.md", "llms.txt"]) expect(index).toContain(`href="${href}"`);
    for (const route of ["#/user-manual", "#/faq", "#/operator-journey", "#/domain-architecture", "#/skill"]) {
      expect(index).toContain(`href="${route}"`);
    }
  });
});
