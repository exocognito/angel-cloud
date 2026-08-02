import { existsSync, readFileSync } from "node:fs";
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
const cliUserGuidePath = new URL(
  "../../docs/aprd/v2.1-cli-user-guide.md",
  import.meta.url,
);
const generativeEvalsPath = new URL(
  "../../docs/aprd/v2.1-generative-evals.md",
  import.meta.url,
);
const cliUserGuide = existsSync(cliUserGuidePath)
  ? readFileSync(cliUserGuidePath, "utf8")
  : "";
const generativeEvals = existsSync(generativeEvalsPath)
  ? readFileSync(generativeEvalsPath, "utf8")
  : "";
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
    expect(html).toContain("● 19 green");
    expect(html).toContain("● 2 yellow");
    expect(html).toContain("● 6 orange");
    expect(html).toContain("● 2 red");
    expect(html).toContain("public-trust-page regraded 2026-08-01 · WS-E privacy review");
    expect(count(/class="card g"/g)).toBe(19);
    expect(count(/class="card y"/g)).toBe(2);
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
    expect(html).toContain("The Product Ledger owns the");
    expect(html).toContain("final goal, roadmap, learning disposition, and build approval.");
  });

  test("marks the APRD draft unapproved and gives the Product Ledger precedence", () => {
    expect(html).toContain("Do not build from this draft.");
    expect(html).toContain('href="../product-ledger.html"');
    expect(aprdReadme).toContain("The [Angel Product Ledger](../product-ledger.html) owns the final goal, roadmap,");
    expect(aprdReadme).toContain("**not approved for implementation**");
    expect(aprdReadme).toContain("its v2.1 build contract");
    expect(roadmap).toContain("[Angel Product Ledger](docs/product-ledger.html)");
    expect(roadmap).toContain("WS-E is active");
    expect(roadmap).toContain("evidence-only approval covers WS-E");
    expect(roadmap).toContain("**WS2 and Dogfood Round 2**");
    expect(roadmap).toContain("remain proposed and unapproved");
    expect(roadmap).toContain("APRD v2");
    expect(roadmap).toMatch(/remains\s+unapproved for implementation/);
    expect(roadmap).not.toContain("This file is the canonical plan of record");
  });

  test("checks current publish behavior against the package pin and public docs", async () => {
    expect(packageManifest.dependencies["@smcllns/angel-core"]).toBe("workspace:0.3.0");
    expect(JSON.parse(readFileSync(new URL("../../packages/core/package.json", import.meta.url), "utf8")).version).toBe("0.3.0");
    expect(corePackageManifest.version).toBe("0.3.0");
    expect(roadmap).not.toContain("waits on `@smcllns/angel-core`");
    expect(rootReadme).toContain("to production by default");
    expect(rootReadme).toContain("bun run angel publish golden-assistant --preview");
    expect(rootReadme).toContain("hosted and core test suites");
    expect(rootReadme).not.toMatch(/\d+ hosted tests \/ [\d,]+ assertions/);
    expect(rootReadme).toMatch(/registry network access and\s+the pinned toolchain/);
    expect(rootReadme).not.toContain("482 tests / 2,982 assertions");
    expect(userManual).toContain("Production is the default in `@smcllns/angel-core` 0.3.0");
    expect(userManual).toContain("pnpm exec angel delete  <angel> [--confirm <slug>]");
    expect(userManual).toContain('"preview":');
    expect(userManual).not.toContain('"staging":');
    expect(userManual).toContain("The canonical repository runs this against workspace-linked");
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
      expect(currentDoc).toContain("workspace lockfile");
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
    for (let i = 1; i <= 16; i += 1) {
      expect(html).toContain(`id="e${i}"`);
      expect(html).toContain(`<strong>E${i} ·`);
    }
    expect(html).toContain("Evidence contracts · E1–E16");
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

  test("makes the CLI-first golden path an executable v2.1 contract", () => {
    const heading = "8.1 · Normative CLI-first golden path contract";
    const start = html.indexOf(heading);
    expect(start).toBeGreaterThan(0);

    const section = html.slice(start, html.indexOf("8.2 ·", start));
    expect(section).toContain("persona: a developer's own agent");
    expect(section).toContain("empty starting state: a new directory with no repository clone");
    expect(section).toContain("public-doc-only entry point: https://docs.angelmcp.ai/llms.txt");
    expect(section).toContain("v2.1 install path: <strong>BLOCKED by O1</strong>");
    expect(section).toContain("No install command is normative until namespace control and the final package identity are proved");
    expect(section).not.toContain("pnpm add --global @smcllns/angel-core@v2.1");
    expect(section).toContain("The final package must install the bare <code>angel</code> command.");
    expect(section).toContain("human-only handoffs: magic-link browser sign-in, Google Cloud OAuth-client setup, provider consent, and final Gmail draft review");
    expect(section).toContain("source/policy approval boundary: owner approves ANGEL.yaml before build, serve, publish, verify, receipt pull, or replay");
    expect(section).toContain("Local-only independence proof");
    expect(section).toContain("Angel Cloud is unavailable and no Account login exists");
    expect(section).toContain("local MCP proof: <code>angel serve local-draft-proof --port 7423 --grant local-gmail</code>");
    expect(section).not.toContain("angel serve local-draft-proof --port 7423 --connection");
    expect(section).toContain("http://localhost:7423/mcp");
    expect(section).toContain("Apply the printed production binding edit to <code>angels/gmail-draft-assistant/angel.json</code>");
    expect(section).toContain("production-default publish: <code>angel publish gmail-draft-assistant</code>");
    expect(section).toContain("no-op replay: the unchanged publish returns the same Version and digest and prints no new keys");
    expect(section).toContain("verify: <code>angel verify gmail-draft-assistant --production</code>");
    expect(section).toContain("trust boundary: everything attestable is client-checkable; execution is trusted, bounded by replay.");
    expect(section).toContain("agent call: tools/list, then tools/call gmail.users.drafts.create");
    expect(section).toContain('<code class="break-all">POST https://mcp.angelmcp.ai/');
    expect(section).toContain("two receipts: Gateway and Broker");
    expect(section).toContain("anchored tail: sequence, previousHash, hash");
    expect(section).toContain("angel receipts pull gmail-draft-assistant --production --gate gateway --from 128 --to 151 --anchor 127:&lt;gateway-hash&gt; --out receipts/gateway-128-151.ndjson");
    expect(section).toContain("angel receipts pull gmail-draft-assistant --production --gate broker --from 93 --to 108 --anchor 92:&lt;broker-hash&gt; --out receipts/broker-93-108.ndjson");
    expect(section).toContain("angel replay gmail-draft-assistant --receipts receipts/gateway-128-151.ndjson --receipts receipts/broker-93-108.ndjson --bundle build/angel.version.json");
    expect(section).not.toContain("--fail-on-tamper");
    expect(section).not.toMatch(/angel serve[^<\n]*--replay/);
    expect(html).not.toMatch(/angel serve[^<\n]*--replay/);
    expect(section).toContain("failure boundaries: every unsafe step fails before provider work");
    expect(section).toContain("done: Gmail contains a draft and no sent message");
    expect(section).toContain("href=\"v2.1-cli-user-guide.md\"");
    expect(section).toContain("href=\"v2.1-generative-evals.md\"");
    expect(section).not.toContain("pnpm exec angel");
    expect(section).not.toContain("angelmcp-control-demo.sam-633.workers.dev");
    expect(section).not.toContain("or equivalent");
  });

  test("owns the complete final v2.1 command contract in a target-state APRD guide", () => {
    expect(cliUserGuide).toContain("# Angel Cloud v2.1 CLI user guide");
    expect(cliUserGuide).toContain("Normative v2.1 command contract");
    expect(cliUserGuide).toContain("Target-state contract, not shipped current behavior");
    expect(cliUserGuide).toContain("Install contract — blocked by O1");
    expect(cliUserGuide).toContain("No install command is normative while O1 is open");
    expect(cliUserGuide).toContain("O1 must prove namespace control and fix the final package identity");
    expect(cliUserGuide.replace(/\s+/g, " ")).toContain("built candidate passes the WS2 install acceptance");
    expect(cliUserGuide).toContain("<O1-BLOCKED-FINAL-INSTALL-COMMAND>");
    expect(cliUserGuide).not.toContain("pnpm add --global @smcllns/angel-core@v2.1");
    expect(cliUserGuide).toContain("must install the bare `angel` binary");
    expect(cliUserGuide).not.toContain("pnpm exec angel");
    expect(cliUserGuide).not.toContain("angelmcp-control-demo.sam-633.workers.dev");
    expect(cliUserGuide).not.toContain("angelmcp-gateway-demo.sam-633.workers.dev");

    const commands = [
      "angel account login",
      "angel create",
      "angel apps connect",
      "angel build",
      "angel serve",
      "local MCP `tools/list` / `tools/call`",
      "angel publish",
      "angel verify",
      "angel receipts pull",
      "angel replay",
      "production MCP `tools/list` / `tools/call`",
    ];
    for (const command of commands) {
      const heading = `## ${command}`;
      const start = cliUserGuide.indexOf(heading);
      expect(start).toBeGreaterThan(0);
      const next = cliUserGuide.indexOf("\n## ", start + heading.length);
      const section = cliUserGuide.slice(start, next === -1 ? undefined : next);
      for (const field of [
        "Purpose:",
        "Syntax:",
        "Inputs:",
        "Outputs:",
        "Durable side effects:",
        "Human-only handoffs:",
        "Idempotency and retry:",
        "Failure boundaries:",
        "Example:",
      ]) {
        expect(section).toContain(field);
      }
    }
  });

  test("defines exact receipt pull and replay syntax in the target command guide", () => {
    expect(cliUserGuide).toContain("angel receipts pull <angel> --production --gate <gateway|broker> --from <sequence> --to <sequence> --anchor <sequence>:<hash> --out <path>");
    expect(cliUserGuide).toContain("angel receipts pull <angel> --production --gate <gateway|broker> --from 1 --to <sequence> --bootstrap --out <path>");
    expect(cliUserGuide.replace(/\s+/g, " ")).toContain("Exactly one of `--anchor` or `--bootstrap` is required");
    expect(cliUserGuide.replace(/\s+/g, " ")).toContain("first exported `previousHash` must equal the supplied trusted hash");
    expect(cliUserGuide).toContain("angel.replay-receipt.v1");
    expect(cliUserGuide.replace(/\s+/g, " ")).toContain("top-level `schema`, `gate`, `anchor`, `request`, and `receipt`");
    expect(cliUserGuide).toContain("every current `GateReceipt` field");
    expect(cliUserGuide).toContain("export-added `bundleDigest` and `engineVersion`");
    expect(cliUserGuide).toContain("Each file contains one gate's contiguous chain only");
    expect(cliUserGuide).toContain("Gateway denial has no Broker partner");
    expect(cliUserGuide.replace(/\s+/g, " ")).toContain("correlates allowed Gateway and Broker records by `requestId`");
    for (const field of ["accountId", "angelId", "environment", "requestId", "tool", "provider", "operation", "connectionId", "connectionRef", "connectionIdentityLabel"]) {
      expect(cliUserGuide).toContain(`\`${field}\``);
    }
    expect(cliUserGuide.replace(/\s+/g, " ")).toContain("canonical original `arguments`");
    expect(cliUserGuide).toContain("mode `0600`");
    expect(cliUserGuide).toContain("missing original arguments");
    expect(cliUserGuide.replace(/\s+/g, " ")).toContain("recomputes `argumentsDigest` from each record's canonical original arguments");
    expect(cliUserGuide).toContain("angel receipts pull gmail-draft-assistant --production --gate gateway --from 128 --to 151 --anchor 127:<gateway-hash> --out receipts/gateway-128-151.ndjson");
    expect(cliUserGuide).toContain("angel receipts pull gmail-draft-assistant --production --gate broker --from 93 --to 108 --anchor 92:<broker-hash> --out receipts/broker-93-108.ndjson");
    expect(cliUserGuide).toContain("angel replay <angel> --receipts <path> [--receipts <path> ...] --bundle <path>");
    expect(cliUserGuide).toContain("--receipts receipts/gateway-128-151.ndjson --receipts receipts/broker-93-108.ndjson");
    expect(cliUserGuide).toContain("checked count, first sequence, and last sequence for each gate");
    expect(cliUserGuide).not.toContain("--fail-on-tamper");
    expect(cliUserGuide).toContain("angel apps connect google --local");
    expect(cliUserGuide).toContain("angel apps connect google --cloud");
    expect(cliUserGuide).toContain("grant nickname");
    expect(cliUserGuide).toContain("angel serve <angel> [--bundle <path>] [--port <port>] [--grant <nickname>]");
    expect(cliUserGuide).toContain("`--grant` is required when the bundle declares any provider-backed tool");
    expect(cliUserGuide).toContain("angel serve gmail-draft-assistant --port 7423 --grant local-gmail");
    expect(cliUserGuide.replace(/\s+/g, " ")).toContain("local grant nickname");
    expect(cliUserGuide).not.toMatch(/angel serve[^\n]*--connection/);
    expect(cliUserGuide).not.toContain("local provider Connection nickname");
    expect(cliUserGuide).toContain("Angel-owned encrypted vault");
    expect(cliUserGuide).toContain("never in an ambient OS keychain");
    expect(cliUserGuide).toContain("https://api.angelmcp.ai");
    expect(cliUserGuide).not.toContain("https://control.angelmcp.ai");
    expect(cliUserGuide).toContain("Exact management-token storage, encryption, and unlock are a WS2 contract gate");
    expect(cliUserGuide).not.toContain("Account-scoped management token in an\nAngel-owned encrypted local profile");
    expect(html).toContain("Exact management-token storage, encryption, and unlock remain a WS2 contract gate");
    expect(cliUserGuide).toContain("## Fresh local independence journey");
    const localJourney = cliUserGuide.slice(
      cliUserGuide.indexOf("## Fresh local independence journey"),
      cliUserGuide.indexOf("## angel account login"),
    );
    expect(localJourney.replace(/\s+/g, " ")).toContain("Angel Cloud is unavailable");
    expect(localJourney).not.toContain("angel account login");
    expect(localJourney).not.toContain("--cloud");
    expect(cliUserGuide).toContain("exactly 600 seconds after server-side commit");
    expect(cliUserGuide).not.toMatch(/export the (receipt )?lines/i);
    expect(cliUserGuide).toContain("Durable side effects: none. Replay writes no report file");
    expect(cliUserGuide).not.toContain("explicit report output flag");
    expect(html).toContain("Replay starts no server, opens no port, reads no credential store, writes no report file, and makes no network or provider call");
  });

  test("specifies high-leverage generative eval families and bans hard-coded passes", () => {
    expect(generativeEvals).toContain("# Angel Cloud v2.1 generative eval specification");
    expect(generativeEvals).toContain("Target-state v2.1 eval contract");
    expect(generativeEvals).toContain("The generated E2E test file itself must be saved as evidence");

    expect(generativeEvals).toContain("## public review summary privacy, stability, and HTML/JSON parity");
    expect(generativeEvals.replace(/\s+/g, " ")).toContain("outside candidate sees public surfaces and generated inputs only");
    expect(generativeEvals).not.toContain("after the evaluator sees the current repository state");
    expect(generativeEvals).not.toContain("after the evaluator sees repository fixtures");
    expect(generativeEvals).toContain("missing original arguments");
    expect(generativeEvals).toContain("edit original arguments");
    expect(generativeEvals).toContain("edit detail");
    expect(cliUserGuide).toContain("recorded-versus-local decision and detail comparisons");
    expect(cliUserGuide).toContain("recorded-versus-local detail disagreement");
    expect(generativeEvals).toContain("Gateway-only denial before a later allowed call");
    expect(generativeEvals).toContain("independent Gateway and Broker anchors");
    const families = [
      "docs-only fresh-machine journey with a newly generated Angel",
      "novel generated policies and guards",
      "local/cloud artifact and decision parity with tamper detection",
      "account isolation, idempotent retry, and zero provider calls on failure",
      "public review summary privacy, stability, and HTML/JSON parity",
      "live Gmail draft-without-send supplement",
    ];
    for (const family of families) {
      const heading = `## ${family}`;
      const start = generativeEvals.indexOf(heading);
      expect(start).toBeGreaterThan(0);
      const next = generativeEvals.indexOf("\n## ", start + heading.length);
      const section = generativeEvals.slice(start, next === -1 ? undefined : next);
      for (const field of [
        "Input grammar:",
        "Degrees of freedom:",
        "Unseen requirement:",
        "Observable real-system evidence:",
        "Semantic/property grader:",
      ]) {
        expect(section).toContain(field);
      }
    }

    for (const phrase of [
      "exactly one of `--local` or `--cloud`",
      "Angel-owned encrypted vault",
      "exactly 600 seconds after server-side commit",
      "Replay tamper detection is mandatory",
      "known fixture names",
      "static output strings",
      "mocked provider success",
      "must generate unseen names, source, policies, arguments, Accounts, Connections, and mutations",
    ]) {
      expect(generativeEvals).toContain(phrase);
    }
  });

  test("keeps target contracts in the unapproved APRD draft while current docs stay shipped-only", () => {
    expect(aprdReadme).toContain("WS-E reconciled O2–O7 into this draft");
    expect(aprdReadme).toContain("O1 and O10 still block approval");
    expect(html).toContain("WS-E reconciled O2–O7 into this draft");
    expect(html).toContain("O1 and O10 still block approval");
    expect(html).toContain('href="v2.1-cli-user-guide.md"');
    expect(html).toContain('href="v2.1-generative-evals.md"');
    expect(html).toContain("The current user manual remains the shipped Milestone 1 manual");

    expect(userManual).toContain("## Milestone 1: what is live");
    expect(userManual).toContain("It has four subcommands:");
    for (const unshippedCommand of [
      "angel account login",
      "angel create",
      "angel apps connect",
      "angel serve",
      "angel verify",
      "angel receipts pull",
      "angel replay",
    ]) {
      expect(userManual).not.toContain(unshippedCommand);
      expect(publicSkill).not.toContain(unshippedCommand);
    }
  });

  test("keeps closed O6 and O7 contracts exact in the APRD", () => {
    expect(html).toContain("Account deletion is an asynchronous, retryable hard-delete");
    expect(html).toContain("Provider App / grant / Connection");
    expect(html).toContain("A local grant profile stores that grant in the Angel-owned encrypted local vault");
    expect(html).toContain("A cloud Connection stores it write-only in Broker custody");
    expect(html).toContain("Local grant profiles belong to the local owner and device, not to a cloud Account");
    expect(html).toContain("non-resolving tombstones for current and retired handles");
    expect(html).toContain("A transient failure leaves the Account disabled and retryable");
    expect(html).not.toContain("cascade details open");
    expect(html).not.toContain('Delete-account cascade details beyond "cascades angels · keys · apps"');
    expect(html).toContain("<code>angel.public-review.v1</code>");
    expect(html).toContain("Evidence contracts · E1–E16");
    expect(html).toContain('id="e16"');
    expect(html).toContain("semantically identical HTML and JSON projections of one strict <code>angel.public-review.v1</code> object");
    expect(html).toMatch(/data-commitment-target="Every Angel has a public trust page" data-current="yellow"[^>]+data-evidence="e16"/);
    const publicPageCard = html.slice(html.indexOf("Every Angel has a public trust page") - 120, html.indexOf("Every Angel has a public trust page") + 300);
    expect(publicPageCard).toContain('class="card y"');
    expect(publicPageCard).toContain('<span class="chip">Yellow</span>');
    expect(html).toContain("sessions stay host-only on <code>dash.</code> and <code>auth.</code> (I14)");
    expect(html).toContain("Route logic at <code>src/workers/gateway.ts:299</code>.");
    expect(html).toContain("one owner-only nonce per published Version");
    expect(html).toContain("remove or gate the raw <code>policyDigest</code> on every public surface for that Version");
    expect(html).toContain("capability-summary-only");
    expect(html).not.toContain("public coordinate browser and JSON proof showing charter, tools, guards, Version, digest");
  });

  test("defines a complete v2.1 target color matrix for all commitments", () => {
    const heading = "8.2 · Normative v2.1 commitment target matrix";
    const start = html.indexOf(heading);
    expect(start).toBeGreaterThan(0);

    const section = html.slice(start);
    const rows = [...section.matchAll(/<tr data-commitment-target="([^"]+)" data-current="(green|yellow|orange|red)" data-v21-target="green" data-evidence="(e\d+)">/g)];
    expect(rows).toHaveLength(29);

    const commitments = [
      "An Angel cannot act",
      "Rules are compiled, never judged",
      "One invocation surface, fixed service topology",
      "Absence, not refusal",
      "Guards bind arguments",
      "Two receipts or nothing happens",
      "What can't execute doesn't deploy",
      "Byte-for-byte promotion",
      "One command to live",
      "Preview never touches real data silently",
      "Credentials go in, never out",
      "Other tenants don't exist",
      "Nicknames never reach agents",
      "Selection, never fan-out",
      "Reset must never invent custody",
      "Plaintext once, stable across deploys",
      "Key names bounded on every surface",
      "Handles hold their meaning",
      "Every Angel has a public trust page",
      "Pause only removes",
      "Delete is deliberate and total",
      "Mutations are idempotent",
      "The docs are open to any agent",
      "An agent can do the whole journey alone",
      "The flagship moment: draft, never send",
      "Anchored receipt tail",
      "Engine pinned per angel",
      "Behavior spot-checkable by replay",
      "The trust boundary is stated, not implied",
    ];
    expect(rows.map((row) => row[1])).toEqual(commitments);
    expect(section).toContain("v2.1 exit criterion: 29 green, 0 yellow, 0 orange, 0 red.");

    for (const [, commitment, , evidence] of rows) {
      expect(section).toContain(`<a href="#${evidence}">`);
      expect(html).toContain(`<h4>${commitment}</h4>`);
      expect(html).toContain(`id="${evidence}"`);
    }
  });
});
