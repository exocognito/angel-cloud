import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileHostedAngel } from "../src/domain";
import { buildPortableAngel } from "../src/build";

const DIRECT = `
name: research-assistant
charter: Read mail and documents without changing them.
tools:
  - gmail.users.messages.list
  - tool: docs.documents.get
    argGuards:
      - field: documentId
        pin: doc-reviewed
`;

const GMAIL_LEAF = `
name: gmail-read
tools:
  - gmail.users.messages.list
`;

const DOCS_LEAF = `
name: docs-read
tools:
  - docs.documents.get
`;

const COMPOSITE = `
name: golden-assistant
charter: Read mail and documents.
angels:
  - gmail-read
  - docs-read
`;

describe("portable Angel source", () => {
  test("compiles one direct multi-provider policy into canonical, secret-free Version bytes", async () => {
    const first = await compileHostedAngel(DIRECT);
    const second = await compileHostedAngel(DIRECT);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      format: "angel.version.v2",
      name: "research-assistant",
      charter: "Read mail and documents without changing them.",
      children: [],
      tools: [
        {
          name: "docs.documents.get",
          provider: "docs",
          operation: "docs.documents.get",
          argGuards: [{ field: "documentId", pin: "doc-reviewed" }],
        },
        {
          name: "gmail.users.messages.list",
          provider: "gmail",
          operation: "gmail.users.messages.list",
          argGuards: [],
        },
      ],
      bindingRequirements: [
        {
          id: "docs",
          source: "research-assistant",
          provider: "docs",
          credential: "google_oauth",
          tools: ["docs.documents.get"],
        },
        {
          id: "gmail",
          source: "research-assistant",
          provider: "gmail",
          credential: "google_oauth",
          tools: ["gmail.users.messages.list"],
        },
      ],
    });
    expect(first.canonicalSource).not.toMatch(/con_|acct_|sam-personal|angel-cloud/);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("resolves local child Angels into a flattened Version with exact child digests", async () => {
    const sources: Record<string, string> = {
      "gmail-read": GMAIL_LEAF,
      "docs-read": DOCS_LEAF,
    };
    const [gmail, docs, composite] = await Promise.all([
      compileHostedAngel(GMAIL_LEAF),
      compileHostedAngel(DOCS_LEAF),
      compileHostedAngel(COMPOSITE, {
        loadAngel: (name: string) => sources[name],
      }),
    ]);

    expect(composite.children).toEqual([
      { name: "docs-read", digest: docs.digest },
      { name: "gmail-read", digest: gmail.digest },
    ]);
    expect(composite.tools.map((tool) => tool.name)).toEqual([
      "docs.documents.get",
      "gmail.users.messages.list",
    ]);
    expect(composite.bindingRequirements).toEqual([
      {
        id: "docs-read",
        source: "docs-read",
        provider: "docs",
        credential: "google_oauth",
        requiredScopes: ["https://www.googleapis.com/auth/documents.readonly"],
        tools: ["docs.documents.get"],
      },
      {
        id: "gmail-read",
        source: "gmail-read",
        provider: "gmail",
        credential: "google_oauth",
        requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        tools: ["gmail.users.messages.list"],
      },
    ]);
  });

  test("fails closed on mixed forms, unknown keys, and non-local references", async () => {
    await expect(compileHostedAngel(`${DIRECT}\nangels: [gmail-read]\n`)).rejects.toThrow(
      /exactly one of tools or angels/,
    );
    await expect(compileHostedAngel(DIRECT.replace("name:", "account: private\nname:"))).rejects.toThrow(
      /unknown key: account/,
    );
    await expect(compileHostedAngel(COMPOSITE.replace("gmail-read", "../gmail-read"), {
      loadAngel: () => GMAIL_LEAF,
    })).rejects.toThrow(/lowercase slug/);
    await expect(compileHostedAngel(DIRECT.replace("tools:", "API_KEY: literal\ntools:")))
      .rejects.toThrow(/unknown key: API_KEY/);
    await expect(compileHostedAngel("name: mail\ntools: [gmail.users.messages.notARealOperation]"))
      .rejects.toThrow(/not in the gmail adapter/);
  });

  test("fails closed on missing children, cycles, and canonical tool collisions", async () => {
    await expect(compileHostedAngel(COMPOSITE, {
      loadAngel: () => undefined,
    })).rejects.toThrow(/local Angel not found/);

    const cycle = `name: gmail-read\nangels: [golden-assistant]\n`;
    await expect(compileHostedAngel(COMPOSITE, {
      loadAngel: (name: string) => name === "gmail-read" ? cycle : COMPOSITE,
    })).rejects.toThrow(/composition cycle/);

    const duplicateDocs = `name: gmail-read\ntools: [docs.documents.get]\n`;
    await expect(compileHostedAngel(COMPOSITE, {
      loadAngel: (name: string) => name === "gmail-read" ? duplicateDocs : DOCS_LEAF,
    })).rejects.toThrow(/composed tool collision/);
  });
});

describe("portable Angel filesystem build", () => {
  test("provides a dedicated static Version builder without changing the legacy builder", async () => {
    const module = await import("../src/build").catch(() => ({}));
    expect(typeof (module as { buildPortableAngel?: unknown }).buildPortableAngel).toBe("function");
  });

  test("writes canonical Version bytes and digest sidecar byte-identically on rebuild", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "angel-portable-build-"));
    for (const [name, source] of [
      ["gmail-read", GMAIL_LEAF],
      ["docs-read", DOCS_LEAF],
      ["golden-assistant", COMPOSITE],
    ] as const) {
      const directory = join(repoRoot, "angels", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "ANGEL.yaml"), source);
    }

    const first = await buildPortableAngel({ repoRoot, angelId: "golden-assistant" });
    const versionBytes = readFileSync(join(first.outDir, "angel.version.json"), "utf8");
    const digestBytes = readFileSync(join(first.outDir, "angel.version.sha256"), "utf8");
    const second = await buildPortableAngel({ repoRoot, angelId: "golden-assistant" });

    expect(readdirSync(first.outDir).sort()).toEqual([
      "angel.version.json",
      "angel.version.sha256",
    ]);
    expect(versionBytes).toBe(`${first.artifact.canonicalSource}\n`);
    expect(digestBytes).toBe(`${first.artifact.digest}\n`);
    expect(readFileSync(join(second.outDir, "angel.version.json"), "utf8")).toBe(versionBytes);
    expect(second.artifact.digest).toBe(first.artifact.digest);
  });
});
