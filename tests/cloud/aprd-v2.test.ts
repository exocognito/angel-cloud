import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { runAngelCommand } from "@smcllns/angel-core/cli";
import type { PortableBuildResult } from "@smcllns/angel-core/build";

const html = readFileSync(
  new URL("../../docs/aprd/angel-cloud-aprd.html", import.meta.url),
  "utf8",
);
const aprdReadme = readFileSync(
  new URL("../../docs/aprd/README.md", import.meta.url),
  "utf8",
);
const roadmap = readFileSync(
  new URL("../../ROADMAP.md", import.meta.url),
  "utf8",
);
const rootReadme = readFileSync(
  new URL("../../README.md", import.meta.url),
  "utf8",
);
const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { dependencies: Record<string, string> };
const corePackageManifest = JSON.parse(
  readFileSync(
    new URL(
      "../../node_modules/@smcllns/angel-core/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { version: string };
const faq = readFileSync(new URL("../../docs/faq.md", import.meta.url), "utf8");
const userManual = readFileSync(
  new URL("../../docs/user-manual.md", import.meta.url),
  "utf8",
);
const operatorJourney = readFileSync(
  new URL("../../docs/google-read-proof-manual-journey.md", import.meta.url),
  "utf8",
);
const publicSkill = readFileSync(
  new URL("../../docs-site/public/SKILL.md", import.meta.url),
  "utf8",
);
const publicLlms = readFileSync(
  new URL("../../docs-site/public/llms.txt", import.meta.url),
  "utf8",
);
const publicIndex = readFileSync(
  new URL("../../docs-site/public/index.html", import.meta.url),
  "utf8",
);
const researchConfigurationReadme = readFileSync(
  new URL(
    "../../research/hosted-platform/example-configurations/README.md",
    import.meta.url,
  ),
  "utf8",
);
const researchConfigurations = [
  "communications-stack.angel.json",
  "gmail-inbox-zero.angel.json",
  "golden-research-assistant.angel.json",
].map((name) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../research/hosted-platform/example-configurations/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { bindings: Record<string, unknown> }
);
const v1AudienceViews = [
  "../../docs/aprd/aprd-views.html",
  "../../docs/aprd/views/design.html",
  "../../docs/aprd/views/engineering.html",
  "../../docs/aprd/views/marketing.html",
  "../../docs/aprd/views/support.html",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const productDecisionIndex = readFileSync(
  new URL("../../docs/product-decisions/README.md", import.meta.url),
  "utf8",
);
const previewDecision = readFileSync(
  new URL(
    "../../docs/product-decisions/0003-preview-is-opt-in.md",
    import.meta.url,
  ),
  "utf8",
);
const previewBindingsDecision = readFileSync(
  new URL(
    "../../docs/product-decisions/0005-preview-binds-its-own-connections.md",
    import.meta.url,
  ),
  "utf8",
);
const productDecision = readFileSync(
  new URL(
    "../../docs/product-decisions/0006-www-is-a-full-write-surface.md",
    import.meta.url,
  ),
  "utf8",
);
const architectureDecision = readFileSync(
  new URL(
    "../../docs/adrs/0006-browser-source-and-client-compilation.md",
    import.meta.url,
  ),
  "utf8",
);

function count(pattern: RegExp): number {
  return [...html.matchAll(pattern)].length;
}

describe("APRD v2", () => {
  test("keeps the agreed structure and puts phasing last", () => {
    const headings = [
      "0 · Terminology",
      "1 · Flagship statement",
      "2 · Goals map",
      "3 · Demonstrable commitments",
      "4 · The stations, long form",
      "5 · System diagram",
      "6 · Non-goals and deliberately-not-verified",
      "7 · Open questions",
      "8 · Implementation phasing",
    ];
    let cursor = -1;
    for (const heading of headings) {
      const next = html.indexOf(heading);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }

    const phasing = html.indexOf("8 · Implementation phasing");
    expect(html.indexOf('<span class="phase-chip')).toBeGreaterThan(phasing);
    expect(html).toContain("The map in §2 is the complete design.");
    expect(html).toContain("Scope shrinks by choosing a subset to build — never by cutting the map");
  });

  test("maps ten linked stations across all three surfaces", () => {
    expect(count(/href="#s(?:10|[1-9])"/g)).toBe(10);
    expect(count(/id="s(?:10|[1-9])"/g)).toBe(10);
    expect(html).toContain("grid-template-columns: 118px 1fr 1fr 1fr");

    for (const target of html.matchAll(/href="#([^"]+)"/g)) {
      expect(html).toContain(`id="${target[1]}"`);
    }
  });

  test("grades commitments against the pinned branch commit", () => {
    expect(html).toContain("main@faf4beb");
    expect(html).toContain("● 20 green");
    expect(html).toContain("● 1 yellow");
    expect(html).toContain("● 6 orange");
    expect(html).toContain("● 2 red");
    expect(count(/class="card g"/g)).toBe(20);
    expect(count(/class="card y"/g)).toBe(1);
    expect(count(/class="card o"/g)).toBe(6);
    expect(count(/class="card r"/g)).toBe(2);
  });

  test("carries the four new trust commitments without breaking redaction", () => {
    for (const title of [
      "Anchored receipt tail",
      "Engine pinned per angel",
      "Behavior spot-checkable by replay",
      "The trust boundary is stated, not implied",
    ]) {
      expect(html).toContain(`<h4>${title}</h4>`);
    }
    expect(html).toContain("<code>sequence</code>, <code>previousHash</code>, and <code>hash</code> become agent-facing so the client can anchor");
    expect(html).toContain("the first receipt's <code>previousHash</code> must equal the remembered hash");
    expect(html).toContain("Receipt <code>argumentsDigest</code> becomes agent-facing for local replay");
    expect(html).toContain("the v2 agent-facing receipt carries the cloud's <code>argumentsDigest</code>");
    expect(html).not.toContain("chain hashes appear on no agent-facing surface");
    expect(html).toContain("execution is trusted, bounded by replay");
  });

  test("records the code-grounded map regrades", () => {
    expect(html).toContain('text-amber-600">home:MagicLinkForm');
    expect(html).not.toContain('text-red-600">home:MagicLinkForm');
    expect(html).toContain('text-amber-600">angels:create → new:CharterEditor (tools|children)');
    expect(html).toContain('text-amber-600">[slug]:Publish → hero result');
    expect(html).toContain('text-amber-600">[slug]:PolicyEditor');
    expect(html).not.toContain('text-emerald-700">[slug]:ToolRow.toggle');
    expect(html).toContain('text-emerald-700">[slug]:KeysPanel.New → Revoke');
    expect(html).toContain('text-amber-600">angel keys new|revoke');
    expect(html).toContain("sends <span class=\"font-mono\">pause_tool</span> / <span class=\"font-mono\">resume_tool</span>");
    expect(html).toContain("The current page does make other writes — Promote, availability changes, and key lifecycle actions");
    expect(html).toContain('<span class="text-emerald-700">[slug]:Settings.Availability</span> · <span class="text-amber-600">MasterToggle</span>');
    expect(html).not.toContain("This station is red");
    expect(html).toContain("This station is amber — agreed and unbuilt");
    expect(html).toContain('href="#s2" class="m-1 rounded border-2 border-emerald-300');
  });

  test("keeps the CLI-first phase coherent with its human web steps", () => {
    expect(html).toContain('<span class="phase-chip p21">v2.1</span> MagicLinkForm + Better Auth (required by CLI login)');
    expect(html).toContain('<span class="phase-chip p22">v2.2</span> PolicyEditor: charter · tools · guards');
    expect(html).toContain('<span class="phase-chip pdone">done</span> KeysPanel New → Revoke');
    expect(html).not.toContain('<span class="phase-chip pdone">done</span> toggle');
    expect(html).toContain('<td class="p-2 text-slate-400 font-sans">— consent stays human</td>');
    expect(html).not.toContain('<span class="phase-chip pdone">done</span> stays human');
  });

  test("pins the reproducible digest and explains the newline footgun", () => {
    expect(html).toContain("a004a3a3e1b06092…6eecdc5a");
    expect(html).toContain("canonical bytes <em>without</em> a trailing newline");
    expect(html).toContain("a naive <span class=\"font-mono text-sm\">shasum</span>");
  });

  test("marks only the actual system additions as future", () => {
    expect(html).toContain('BA["Better Auth<br/>D1 storage · email links"]');
    expect(html).toContain('APX["Apex public-page route<br/>angelmcp.ai/@handle/angel"]');
    expect(html).toContain('SRC[("Source drafts<br/>inside AccountRegistry<br/>owner-only")]');
    expect(html).toContain("class SRV,BA,APX,SRC change");
    expect(html).not.toContain("class SRV,C change");
    expect(html).not.toContain('G["Gateway<br/>mcp. — POST invokes,<br/>GET renders the trust page"]');
  });

  test("retains v1 safety and precedence clauses", () => {
    expect(html).toContain("Neither gate falls back to an older Version or availability state.");
    expect(html).toContain("Custody failure throws; it never substitutes a fixture.");
    expect(html).toContain("Fail closed beats");
    expect(html).toContain("Publish-time rejection beats runtime failure.");
    expect(html).toContain("ROADMAP.md owns delivery sequence and status.");
  });

  test("keeps the APRD entry points aligned with v2", () => {
    expect(aprdReadme).toContain("The goals map (§2) and");
    expect(aprdReadme).toContain("Phasing (§8) chooses build order and never narrows that design.");
    expect(aprdReadme).not.toContain("Spine > Evals");
    expect(aprdReadme).not.toContain("toggle at the bottom right");
    expect(aprdReadme).not.toContain("Prototype flow F");
    expect(roadmap).toContain("the goals map, demonstrable commitments,");
    expect(roadmap).not.toContain("the spine, invariants, interface types,");
  });

  test("checks current publish behavior against the package pin and public docs", async () => {
    expect(packageManifest.dependencies["@smcllns/angel-core"]).toBe("0.3.0");
    expect(corePackageManifest.version).toBe("0.3.0");
    expect(roadmap).not.toContain("waits on `@smcllns/angel-core`");
    expect(rootReadme).toContain("to production by default");
    expect(rootReadme).toContain("bun run angel publish golden-assistant --preview");
    expect(userManual).toContain("Production is the default in `@smcllns/angel-core` 0.3.0");
    expect(userManual).toContain("pnpm exec angel delete  <angel> [--confirm <slug>]");
    expect(userManual).toContain('"preview":');
    expect(userManual).not.toContain('"staging":');
    expect(userManual).toContain("The hosted repository runs this against public");
    expect(previewDecision).toContain("- Implemented: Yes");
    expect(previewBindingsDecision).toContain("- Implemented: Yes");
    expect(productDecisionIndex).toContain("| [0003](0003-preview-is-opt-in.md)");
    expect(productDecisionIndex).toContain("| [0005](0005-preview-binds-its-own-connections.md)");
    expect(productDecisionIndex).not.toContain("| Partly | [#3]");

    const build: PortableBuildResult = {
      artifact: {
        format: "angel.version.v2",
        name: "publish-default-probe",
        charter: "",
        children: [],
        providers: {},
        bindingRequirements: [{
          id: "probe",
          source: "publish-default-probe",
          provider: "gmail",
          credential: "google_oauth",
          requiredScopes: [],
          tools: [],
        }],
        tools: [],
        canonicalSource: "{}",
        digest: "a".repeat(64),
      },
      outDir: "/tmp/not-written",
    };
    const config = {
      target: "https://control.example",
      account: "acct_probe",
      angel: "publish-default-probe",
      bindings: {
        preview: { probe: "preview-only" },
        production: { probe: "production-only" },
      },
    };
    const dependencies = {
      repoRoot: "/tmp/not-read",
      env: { ANGEL_MANAGEMENT_TOKEN: "test-token" },
      build: async () => build,
      loadDeploymentConfig: () => config,
      fetch: async () => Response.json([]),
      output: () => {},
    };

    await expect(
      runAngelCommand(["publish", "publish-default-probe"], dependencies),
    ).rejects.toThrow("Connection nickname production-only was not found");
    await expect(
      runAngelCommand(
        ["publish", "publish-default-probe", "--preview"],
        dependencies,
      ),
    ).rejects.toThrow("Connection nickname preview-only was not found");
  });

  test("keeps the core 0.3 migration aligned across every current journey", () => {
    for (const currentDoc of [rootReadme, userManual, faq]) {
      expect(currentDoc).toMatch(
        /Public\s+`@smcllns\/angel-core@0\.3\.0` is\s+published/,
      );
      expect(currentDoc).toContain("matching lockfile");
      expect(currentDoc).not.toContain("remote CI is green");
    }

    expect(publicSkill).toContain("The CLI accepts four subcommands");
    expect(publicSkill).toContain("and `delete`");
    expect(publicSkill).toContain('"preview":');
    expect(publicSkill).not.toContain('"staging":');
    expect(publicSkill).toContain("pnpm exec angel publish google-read-proof --preview");
    expect(publicSkill).toContain("Without `--preview`, core 0.3.0 publishes to production.");
    expect(publicSkill).not.toContain("the pinned CLI");

    expect(operatorJourney).toContain("in the `preview` and");
    expect(operatorJourney).toContain("bun run angel publish google-read-proof --preview");
    expect(operatorJourney).not.toContain("in the `staging` map");

    expect(publicLlms).toContain("Production is the default; add `--preview`");
    expect(publicLlms).toContain("`angel delete`");
    expect(publicIndex).toContain("Publish to production (default) or preview (opt in)");
    expect(publicIndex).toContain("<code>angel publish --preview</code>");

    expect(researchConfigurationReadme).toContain('"preview":');
    expect(researchConfigurationReadme).not.toContain('"staging":');
    expect(researchConfigurationReadme).toContain("`publish --preview` builds and deploys to preview");
    for (const config of researchConfigurations) {
      expect(config.bindings.preview).toBeDefined();
      expect(config.bindings.staging).toBeUndefined();
    }

    for (const view of v1AudienceViews) {
      expect(view).toContain("V1 audience snapshot.");
      expect(view).toContain("APRD v2 dataroom");
    }
  });

  test("defines every commitment evidence id in the normative document", () => {
    for (let i = 1; i <= 15; i += 1) {
      expect(html).toContain(`id="e${i}"`);
      expect(html).toContain(`<strong>E${i} ·`);
    }
    expect(html).toContain("Evidence contracts · E1–E15");
  });

  test("records www parity as a product decision and updates current docs", () => {
    expect(productDecision).toContain("- Status: Agreed");
    expect(productDecision).toContain("The www product is a full-parity Angel write surface.");
    expect(productDecision).toContain("The publish boundary still accepts only the canonical artifact.");
    expect(productDecisionIndex).toContain("[0006](0006-www-is-a-full-write-surface.md)");
    expect(faq).toContain("That is now an implementation gap, not a permanent boundary.");
    expect(userManual).toContain("That is an unbuilt product");
    expect(faq).not.toContain("No, and that is deliberate.");
    expect(architectureDecision).toContain("browser compiles them:");
    expect(architectureDecision).toContain("For composed `angels:` policies");
    expect(html).toContain("owner reviews the complete source diff");
    expect(html).toContain("no auth cookie is ever scoped to <code>.angelmcp.ai</code>");
  });

  test("keeps the flagship wording visibly open", () => {
    expect(html).toContain("DRAFT — wording awaits Sam's sign-off");
    expect(html).toContain("The sentence is draft because “charter allows” is plain speech while the policy is the only authority");
    expect(html).toContain("Final flagship sentence wording — §1 is a draft until Sam approves it.");
  });
});
