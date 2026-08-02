// Build the fixture the public demo page boots against.
//
// Nothing here is hand-written JSON. The state is produced by the same
// projection code the live dashboard reads — `buildDemoView` over a real
// `ManagementControl` that publishes and promotes the checked-in Angel
// artifacts — and then checked by `assertDemoView`, the producer half of the
// `angelmcp.demo.v4` contract the browser validates on the other side. If the
// read model changes shape, this build fails rather than shipping a stale page.
//
// Usage: bun run scripts/build-demo-fixture.ts <output.json>
import { readFileSync, writeFileSync } from "node:fs";
import { MemoryGateFleet } from "../src/control";
import {
  AesGcmResponseReplayVault,
  ManagementControl,
  createManagementState,
} from "../src/management";
import type {
  ManagementBindingMap,
  ManagementVersionArtifact,
  MutationIdentity,
} from "../src/management-contract";
import { assertDemoView, buildDemoView } from "../src/demo-view";
import type { ConnectionSummary, ProviderAppSummary } from "../src/provider-management";

// Fixed so two builds of the same source produce the same bytes.
const NOW = "2026-07-22T09:30:00.000Z";
const GATEWAY_BASE_URL = "https://angelmcp-gateway-demo.sam-633.workers.dev";

const outputPath = process.argv[2];
if (outputPath === undefined) {
  console.error("usage: bun run scripts/build-demo-fixture.ts <output.json>");
  process.exit(2);
}

const fleets = new Map<string, MemoryGateFleet>();
let id = 0;
const control = ManagementControl.restore(
  createManagementState({
    account: { id: "acct_demo", name: "Personal" },
    connections: [
      {
        id: "con_personal_google",
        accountId: "acct_demo",
        nickname: "personal-google",
        identityLabel: "Personal Google",
        credential: "google_oauth",
        providers: ["gmail", "docs"],
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.labels",
          "https://www.googleapis.com/auth/documents.readonly",
        ],
        health: "healthy",
      },
      {
        id: "con_work_google",
        accountId: "acct_demo",
        nickname: "work-google",
        identityLabel: "Work Google",
        credential: "google_oauth",
        providers: ["gmail"],
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
        health: "healthy",
      },
    ],
  }),
  {
    replayVault: new AesGcmResponseReplayVault("public-demo-fixture-kek"),
    fleetFor: (_angelId, slug) => {
      const fleet = fleets.get(slug) ?? new MemoryGateFleet();
      fleets.set(slug, fleet);
      return fleet;
    },
    randomId: (prefix) => `${prefix}_${++id}`,
    checkpoint: { async persist() {} },
    now: () => NOW,
  },
);

function mutation(idempotencyKey: string, body: unknown): MutationIdentity {
  return { method: "POST", path: `/demo-build/${idempotencyKey}`, idempotencyKey, body };
}

function checkedArtifact(slug: string): ManagementVersionArtifact {
  const canonicalSource = readFileSync(
    new URL(`../examples/angels/${slug}/build/angel.version.json`, import.meta.url),
    "utf8",
  ).trim();
  const digest = readFileSync(
    new URL(`../examples/angels/${slug}/build/angel.version.sha256`, import.meta.url),
    "utf8",
  ).trim();
  return { ...JSON.parse(canonicalSource), canonicalSource, digest };
}

async function deployAngel(slug: string, bindings: ManagementBindingMap): Promise<string> {
  const ensured = await control.ensureAngel("acct_demo", slug, mutation(`ensure-${slug}`, {}));
  const artifact = checkedArtifact(slug);
  const publishBody = { artifact, expectedDigest: artifact.digest };
  const version = await control.publishVersion(
    ensured.angel.id,
    publishBody,
    mutation(`publish-${slug}`, publishBody),
  );
  const previewBody = { versionId: version.id, expectedDigest: version.digest, bindings };
  const preview = await control.deployPreview(
    ensured.angel.id,
    previewBody,
    mutation(`preview-${slug}`, previewBody),
  );
  const productionBody = { stagedDeploymentId: preview.id, expectedDigest: preview.digest, bindings };
  await control.promoteProduction(
    ensured.angel.id,
    productionBody,
    mutation(`promote-${slug}`, productionBody),
  );
  return ensured.angel.id;
}

await deployAngel("gmail-inbox-zero", { gmail: ["con_personal_google"] });
const goldenId = await deployAngel("golden-assistant", {
  "gdocs-read": ["con_personal_google"],
  "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
});

// One paused tool+Connection tuple, so a visitor sees that availability is a
// per-tuple decision rather than an on/off switch for the whole Angel.
await control.changeAvailability(
  goldenId,
  "production",
  {
    kind: "tool_connection",
    tool: "gmail.users.messages.list",
    connectionId: "con_personal_google",
    enabled: false,
  },
  mutation("pause-personal", {}),
);

const view = await buildDemoView(
  control.exportState(),
  (_angelId, slug) => fleets.get(slug)!,
  { gatewayBaseUrl: GATEWAY_BASE_URL },
);
assertDemoView(view);

// The three GET responses the dashboard needs to render. `state` is the
// validated projection; the other two are the provider-custody summaries the
// Control worker returns, typed against the same interfaces it serves
// (src/workers/control.ts enforces those key sets exactly), with no secret
// material of any kind — an app carries only the last four characters of its
// client ID, and a Connection carries only its granted scopes.
// The app's scopes are the consent set it requests, so they must cover every
// scope its Connections were granted below — otherwise the demo would show a
// Connection holding a scope its own Provider App never asked for.
const apps: ProviderAppSummary[] = [
  {
    id: "pa_google_primary",
    accountId: "acct_demo",
    provider: "google",
    displayName: "Google Primary",
    clientIdSuffix: "j2k9",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/documents.readonly",
    ],
  },
];

const connections: ConnectionSummary[] = [
  {
    id: "con_personal_google",
    accountId: "acct_demo",
    nickname: "personal-google",
    providerAppId: "pa_google_primary",
    provider: "google",
    displayName: "Personal Google",
    grantedScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/documents.readonly",
    ],
    health: "healthy",
  },
  {
    id: "con_work_google",
    accountId: "acct_demo",
    nickname: "work-google",
    providerAppId: "pa_google_primary",
    provider: "google",
    displayName: "Work Google",
    grantedScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    health: "healthy",
  },
];

const fixture = { state: view, apps, connections };

writeFileSync(outputPath, JSON.stringify(fixture));
console.log(`demo fixture: ${view.angels.length} angels, validated against assertDemoView`);
