"use strict";

const ACTIONS = new Set(["promote", "pause_all", "resume_all", "pause_tool", "resume_tool"]);
const ENVIRONMENTS = ["preview", "production"];
const KEY_ENVIRONMENT_COPY = "A preview key cannot call production. The production key fingerprint stays stable across promotions.";
let demoState;
let activeEnvironment = "production";
let activeRoute = "home";
let activePane = "permissions";
let activeAngelId = "golden-assistant";
let selectedActivityId;
let activityDecisionFilter = "all";
let toastTimer;
// WP2 Home density (4b): quiet (default) | list | dashboard. A quieter Home
// leads with the Angel health story; denser modes expand each Angel's detail.
let homeDensity = "quiet";
// Agent Keys pane transient state. `keyReveal` holds a freshly minted plaintext
// (create/rotate) shown EXACTLY ONCE in the pane; it is never persisted and is
// cleared on any navigation/re-render. `keysBusy` disables row actions during a
// mutation; `keyError` surfaces a mutation failure inline; `newKeyFormOpen`
// toggles the inline new-key form (no browser prompt()).
let keyReveal = null;
let keysBusy = false;
let keyError = null;
let newKeyFormOpen = false;

function fail(path, expectation) {
  throw new Error(`Invalid demo state: ${path} ${expectation}.`);
}

function record(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value;
}

function exact(value, keys, path) {
  const object = record(value, path);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(path, `must contain exactly ${expected.join(", ")}`);
  }
  return object;
}

function text(value, path) {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
  return value;
}

// A well-formed absolute http(s) URL: scheme, a host of valid DNS labels (each
// starts/ends alphanumeric, hyphens only interior), an optional digits-only port,
// and an optional path. Kept in lockstep with HTTP_URL_PATTERN in src/demo-view.ts
// so the producer and browser agree that every endpoint is a usable absolute URL —
// rejecting malformed authorities (http://:, http://x:abc, http://%) and degenerate
// hosts (http://., http://-, http://foo..bar, http://foo.) while still accepting
// localhost, 127.0.0.1, and interior-hyphen hosts. Deliberately regex-based: no
// client-side URL construction.
const HTTP_URL_PATTERN =
  /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d+)?(?:[/?#]\S*)?$/;

function httpUrl(value, path) {
  const url = text(value, path);
  if (!HTTP_URL_PATTERN.test(url)) fail(path, "must be an absolute http(s) URL");
  return url;
}

function boolean(value, path) {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function integer(value, path) {
  if (!Number.isInteger(value) || value < 0) fail(path, "must be a non-negative integer");
  return value;
}

function nullableInteger(value, path) {
  return value === null ? null : integer(value, path);
}

function nullableText(value, path) {
  return value === null ? null : text(value, path);
}

// Strict ISO-8601 UTC instant: must match the shape AND be a real calendar date.
// A bare non-empty string is NOT a trustworthy timestamp — fail closed. Capture
// groups drive the calendar round-trip check below.
const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

function isoUtc(value, path) {
  const value_ = text(value, path);
  const match = ISO_UTC_PATTERN.exec(value_);
  if (match === null || Number.isNaN(Date.parse(value_))) {
    fail(path, "must be an ISO-8601 UTC timestamp");
  }
  // Reject nonexistent calendar dates (e.g. 2026-02-30) that Date.parse silently
  // normalizes: the parsed UTC components must match the literal input exactly.
  const parsed = new Date(value_);
  if (parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
    || parsed.getUTCHours() !== Number(match[4])
    || parsed.getUTCMinutes() !== Number(match[5])
    || parsed.getUTCSeconds() !== Number(match[6])) {
    fail(path, "must be a real calendar date-time");
  }
  return value_;
}

function nullableIsoUtc(value, path) {
  return value === null ? null : isoUtc(value, path);
}

function recordedTime(value, path) {
  const time = exact(value, ["source", "at"], path);
  const source = oneOf(time.source, ["recorded", "derived"], `${path}.source`);
  if (source === "derived") {
    if (time.at !== null) fail(`${path}.at`, "must be null for a derived time");
    return { source, at: null };
  }
  return { source, at: isoUtc(time.at, `${path}.at`) };
}

function oneOf(value, choices, path) {
  if (!choices.includes(value)) fail(path, `must be one of ${choices.join(", ")}`);
  return value;
}

function list(value, path, validate) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value.map((entry, index) => validate(entry, `${path}[${index}]`));
}

function textList(value, path) {
  return list(value, path, text);
}

function validateConnection(value, path) {
  const connection = exact(value, ["id", "label", "apps", "health"], path);
  return {
    id: text(connection.id, `${path}.id`),
    label: text(connection.label, `${path}.label`),
    apps: textList(connection.apps, `${path}.apps`),
    health: oneOf(connection.health, ["healthy", "error"], `${path}.health`),
  };
}

function validateToolConnection(value, path) {
  const connection = exact(value, ["connectionId", "identity", "available"], path);
  return {
    connectionId: text(connection.connectionId, `${path}.connectionId`),
    identity: text(connection.identity, `${path}.identity`),
    available: boolean(connection.available, `${path}.available`),
  };
}

function validateTool(value, path) {
  const tool = exact(value, ["name", "app", "group", "guards", "connections"], path);
  return {
    name: text(tool.name, `${path}.name`),
    app: text(tool.app, `${path}.app`),
    group: text(tool.group, `${path}.group`),
    guards: textList(tool.guards, `${path}.guards`),
    connections: list(tool.connections, `${path}.connections`, validateToolConnection),
  };
}

function validateBinding(value, path) {
  const binding = exact(value, ["id", "provider", "connectionIds"], path);
  return {
    id: text(binding.id, `${path}.id`),
    provider: text(binding.provider, `${path}.provider`),
    connectionIds: textList(binding.connectionIds, `${path}.connectionIds`),
  };
}

function validateLifecycleEvent(value, path, environmentName) {
  const event = exact(
    value,
    ["kind", "environment", "version", "deploymentId", "order", "source", "at"],
    path,
  );
  const kind = oneOf(
    event.kind,
    ["version_published", "preview_deploy", "production_promotion", "production_deploy"],
    `${path}.kind`,
  );
  // Strict per-environment separation: an event's environment must equal the
  // environment whose lifecycle carries it, and a deploy/promotion kind must
  // match that environment. Preview and production data are never interleaved.
  const eventEnvironment = oneOf(event.environment, ENVIRONMENTS, `${path}.environment`);
  if (eventEnvironment !== environmentName) {
    fail(`${path}.environment`, `must equal ${environmentName} (no cross-environment lifecycle)`);
  }
  const expectedDeployKinds = environmentName === "preview"
    ? ["preview_deploy"]
    : ["production_promotion", "production_deploy"];
  if (kind !== "version_published" && !expectedDeployKinds.includes(kind)) {
    fail(`${path}.kind`, `must be version_published or ${expectedDeployKinds.join("/")} in ${environmentName}`);
  }
  // version_published is version-scoped (no deployment id); a deploy/promotion names its deployment.
  const deploymentId = kind === "version_published"
    ? (event.deploymentId === null ? null : fail(`${path}.deploymentId`, "must be null for version_published"))
    : text(event.deploymentId, `${path}.deploymentId`);
  const source = oneOf(event.source, ["recorded", "derived"], `${path}.source`);
  // Real-vs-derived contract: a derived event never carries a timestamp; a recorded event always does.
  const at = source === "derived"
    ? (event.at === null ? null : fail(`${path}.at`, "must be null for a derived event"))
    : isoUtc(event.at, `${path}.at`);
  return {
    kind,
    environment: eventEnvironment,
    version: integer(event.version, `${path}.version`),
    deploymentId,
    order: integer(event.order, `${path}.order`),
    source,
    at,
  };
}

function validateAgentKey(value, path) {
  const key = exact(value, ["id", "name", "fingerprint", "status", "createdAt", "revokedAt"], path);
  return {
    id: text(key.id, `${path}.id`),
    name: text(key.name, `${path}.name`),
    fingerprint: text(key.fingerprint, `${path}.fingerprint`),
    status: oneOf(key.status, ["active", "revoked"], `${path}.status`),
    createdAt: nullableIsoUtc(key.createdAt, `${path}.createdAt`),
    revokedAt: nullableIsoUtc(key.revokedAt, `${path}.revokedAt`),
  };
}

function validateEnvironment(value, path, environmentName) {
  const environment = exact(
    value,
    ["version", "digest", "deploymentId", "keyFingerprint", "gateAlignment", "pendingAvailabilityRepair", "availability", "keys", "bindings", "tools", "lifecycle"],
    path,
  );
  const alignment = exact(
    environment.gateAlignment,
    ["installation", "availability"],
    `${path}.gateAlignment`,
  );
  const availability = exact(
    environment.availability,
    ["defaultEnabled", "overrides", "revision", "changedAt"],
    `${path}.availability`,
  );
  const overrides = record(availability.overrides, `${path}.availability.overrides`);
  for (const [tool, available] of Object.entries(overrides)) {
    text(tool, `${path}.availability.overrides key`);
    boolean(available, `${path}.availability.overrides.${tool}`);
  }
  return {
    version: nullableInteger(environment.version, `${path}.version`),
    digest: nullableText(environment.digest, `${path}.digest`),
    deploymentId: nullableText(environment.deploymentId, `${path}.deploymentId`),
    keyFingerprint: text(environment.keyFingerprint, `${path}.keyFingerprint`),
    gateAlignment: {
      installation: oneOf(alignment.installation, ["aligned", "mismatched"], `${path}.gateAlignment.installation`),
      availability: oneOf(alignment.availability, ["aligned", "mismatched"], `${path}.gateAlignment.availability`),
    },
    pendingAvailabilityRepair: validateAvailabilityRepair(
      environment.pendingAvailabilityRepair,
      `${path}.pendingAvailabilityRepair`,
    ),
    availability: {
      defaultEnabled: boolean(availability.defaultEnabled, `${path}.availability.defaultEnabled`),
      overrides: { ...overrides },
      revision: integer(availability.revision, `${path}.availability.revision`),
      changedAt: recordedTime(availability.changedAt, `${path}.availability.changedAt`),
    },
    keys: list(environment.keys, `${path}.keys`, validateAgentKey),
    bindings: list(environment.bindings, `${path}.bindings`, validateBinding),
    tools: list(environment.tools, `${path}.tools`, validateTool),
    lifecycle: list(environment.lifecycle, `${path}.lifecycle`, (entry, entryPath) => validateLifecycleEvent(entry, entryPath, environmentName)),
  };
}

function validateAvailabilityRepair(value, path) {
  if (value === null) return null;
  const command = record(value, path);
  const action = oneOf(
    command.action,
    ["pause_all", "resume_all", "pause_tool", "resume_tool"],
    `${path}.action`,
  );
  if (action === "pause_tool" || action === "resume_tool") {
    const keys = ["action", "tool"];
    if (Object.hasOwn(command, "connectionId")) keys.push("connectionId");
    exact(command, keys, path);
    return {
      action,
      tool: text(command.tool, `${path}.tool`),
      ...(command.connectionId === undefined
        ? {}
        : { connectionId: text(command.connectionId, `${path}.connectionId`) }),
    };
  }
  exact(command, ["action"], path);
  return { action };
}

function validateVersion(value, path) {
  const version = exact(value, ["number", "digest", "label", "status", "tools"], path);
  return {
    number: integer(version.number, `${path}.number`),
    digest: text(version.digest, `${path}.digest`),
    label: text(version.label, `${path}.label`),
    status: oneOf(version.status, ["staged", "live", "history"], `${path}.status`),
    tools: textList(version.tools, `${path}.tools`),
  };
}

function validateReady(value, path) {
  if (value === null) return null;
  const ready = exact(
    value,
    ["stagedDeploymentId", "expectedDigest", "fromVersion", "toVersion", "diff", "bindings"],
    path,
  );
  const diff = exact(ready.diff, ["added", "removed"], `${path}.diff`);
  return {
    stagedDeploymentId: text(ready.stagedDeploymentId, `${path}.stagedDeploymentId`),
    expectedDigest: text(ready.expectedDigest, `${path}.expectedDigest`),
    fromVersion: nullableInteger(ready.fromVersion, `${path}.fromVersion`),
    toVersion: integer(ready.toVersion, `${path}.toVersion`),
    diff: {
      added: textList(diff.added, `${path}.diff.added`),
      removed: textList(diff.removed, `${path}.diff.removed`),
    },
    bindings: validateBindingMap(ready.bindings, `${path}.bindings`),
  };
}

function validateBindingMap(value, path) {
  const bindings = record(value, path);
  const normalized = {};
  for (const [requirementId, connectionIds] of Object.entries(bindings)) {
    text(requirementId, `${path} key`);
    normalized[requirementId] = textList(connectionIds, `${path}.${requirementId}`);
  }
  return normalized;
}

function validateReceipt(value, path, nullable) {
  if (value === null) {
    if (nullable) return null;
    fail(path, "must be an object");
  }
  const receipt = exact(value, ["digest", "decision"], path);
  return {
    digest: text(receipt.digest, `${path}.digest`),
    decision: oneOf(receipt.decision, ["allow", "deny"], `${path}.decision`),
  };
}

function validateActivity(value, path) {
  const event = exact(
    value,
    ["requestId", "environment", "tool", "decision", "detail", "gateway", "broker"],
    path,
  );
  return {
    requestId: text(event.requestId, `${path}.requestId`),
    environment: oneOf(event.environment, ENVIRONMENTS, `${path}.environment`),
    tool: text(event.tool, `${path}.tool`),
    decision: oneOf(event.decision, ["allow", "deny"], `${path}.decision`),
    detail: text(event.detail, `${path}.detail`),
    gateway: validateReceipt(event.gateway, `${path}.gateway`, false),
    broker: validateReceipt(event.broker, `${path}.broker`, true),
  };
}

function validateAngel(value, path) {
  // endpoints is a required first-class field in v4 (no optional bypass).
  const angel = exact(
    value,
    ["id", "name", "enabled", "endpoints", "connections", "environments", "versions", "readyForProduction", "activity"],
    path,
  );
  const environments = exact(angel.environments, ENVIRONMENTS, `${path}.environments`);
  const endpoints = exact(angel.endpoints, ENVIRONMENTS, `${path}.endpoints`);
  return {
    id: text(angel.id, `${path}.id`),
    name: text(angel.name, `${path}.name`),
    endpoints: {
      preview: httpUrl(endpoints.preview, `${path}.endpoints.preview`),
      production: httpUrl(endpoints.production, `${path}.endpoints.production`),
    },
    enabled: boolean(angel.enabled, `${path}.enabled`),
    connections: list(angel.connections, `${path}.connections`, validateConnection),
    environments: {
      preview: validateEnvironment(environments.preview, `${path}.environments.preview`, "preview"),
      production: validateEnvironment(environments.production, `${path}.environments.production`, "production"),
    },
    versions: list(angel.versions, `${path}.versions`, validateVersion),
    readyForProduction: validateReady(angel.readyForProduction, `${path}.readyForProduction`),
    activity: list(angel.activity, `${path}.activity`, validateActivity),
  };
}

function validateDemoState(value) {
  const root = exact(value, ["schema", "account", "angels"], "response");
  if (root.schema !== "angelmcp.demo.v4") fail("response.schema", "must equal angelmcp.demo.v4");
  const account = exact(root.account, ["id", "name", "handle"], "response.account");
  return {
    schema: root.schema,
    account: {
      id: text(account.id, "response.account.id"),
      name: text(account.name, "response.account.name"),
      handle: account.handle === null ? null : text(account.handle, "response.account.handle"),
    },
    angels: list(root.angels, "response.angels", validateAngel),
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function loadState() {
  let response;
  try {
    response = await fetch("/api/demo/state", {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`Demo state unavailable: network request failed (${errorMessage(error)}).`);
  }
  if (!response.ok) {
    throw new Error(`Demo state unavailable: HTTP ${response.status}.`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Demo state unavailable: response was not valid JSON (${errorMessage(error)}).`);
  }
  return validateDemoState(payload);
}

async function fetchProvider(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
  } catch (error) {
    throw new Error(`Provider custody unavailable: network request failed (${errorMessage(error)}).`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Provider custody unavailable: response was not valid JSON (${errorMessage(error)}).`);
  }
  if (!response.ok) {
    throw new Error(`Provider custody unavailable: ${payload?.error ?? `HTTP ${response.status}`}.`);
  }
  return payload;
}

let providerApps = [];
let providerConnections = [];

// Display-only scope label: a Google API scope of the form
// `https://www.googleapis.com/auth/<leaf>` shows just its readable `<leaf>`
// (e.g. gmail.readonly, documents.readonly). Anything else — a bare scope like
// "openid"/"email", or an unknown provider URL — passes through unchanged, so
// the transform is never lossy; the chip keeps the full scope as its title.
// Pure string→string so it can be executed without a DOM.
function scopeLabel(scope) {
  const value = String(scope == null ? "" : scope);
  const prefix = "https://www.googleapis.com/auth/";
  if (!value.startsWith(prefix)) return value;
  const leaf = value.slice(prefix.length);
  return leaf === "" ? value : leaf;
}

async function loadProviderCustody() {
  try {
    const [apps, connections] = await Promise.all([
      fetchProvider("/api/provider-apps"),
      fetchProvider("/api/connections"),
    ]);
    if (!Array.isArray(apps) || !Array.isArray(connections)) throw new Error("Provider custody unavailable: response shape was invalid.");
    providerApps = apps;
    providerConnections = connections;
    renderProviderCustody();
    reportCustodyStatus("Provider custody is healthy.", true);
  } catch (error) {
    reportCustodyStatus(errorMessage(error), false);
  }
}

function renderProviderCustody() {
  // Provider Apps — the prototype .acctwrap/.acct-row idiom: a neutral brand
  // plate (Google has no sprite mark, so providerLogo letters it), the display
  // name, then a mono meta line (provider · Client ID ending …). Provider Apps
  // carry no per-app action in the backend, so the row is identity-only.
  const apps = providerApps.map((app) => {
    const row = element("div", "acct-row");
    row.append(providerLogo(app.provider, "sm"));
    row.append(element("span", "an", app.displayName));
    row.append(element("span", "al", `${app.provider} · Client ID ending ${app.clientIdSuffix}`));
    return row;
  });
  const appsEmpty = custodyEmptyNotice(providerApps.length, "No Provider Apps are stored.");
  const appWrap = element("div", "acctwrap");
  appWrap.append(...apps);
  document.querySelector("#provider-app-list").replaceChildren(
    element("div", "cfg-h", "Provider Apps"),
    appsEmpty === null ? appWrap : element("p", "form-note", appsEmpty),
  );
  const selector = document.querySelector("#provider-app-selector");
  selector.replaceChildren();
  if (providerApps.length === 0) {
    selector.append(element("option", "", "No Provider Apps available"));
    selector.disabled = true;
  } else {
    selector.disabled = false;
    selector.append(element("option", "", "Choose a Provider App"));
    selector.options[0].value = "";
    for (const app of providerApps) {
      const option = element("option", "", `${app.displayName} · ${app.provider}`);
      option.value = app.id;
      selector.append(option);
    }
  }
  const connections = providerConnections.map(renderConnectionRow);
  const connectionsEmpty = custodyEmptyNotice(providerConnections.length, "No Google Connections are stored.");
  const connWrap = element("div", "acctwrap");
  connWrap.append(...connections);
  document.querySelector("#provider-connection-list").replaceChildren(
    element("div", "cfg-h", "Connections"),
    connectionsEmpty === null ? connWrap : element("p", "form-note", connectionsEmpty),
  );
}

// A Connection row — a richer prototype composition reusing its atoms: neutral
// brand plate, identity (nickname + displayName · provider), a .pill.live health
// badge, granted scopes as compact mono .cap chips (each truncated for reading
// but carrying the full scope URL as its title, never lossy), and the compact
// .btn.sm lifecycle actions. Each action button carries the opaque connection id
// only in its dataset; a single per-row .conn-feedback slot renders the inline
// busy/failure signal for whichever action is in flight.
function renderConnectionRow(connection) {
  const row = element("div", "conn-row");
  row.append(providerLogo(connection.provider, "sm"));

  const identity = element("div", "conn-identity");
  identity.append(
    element("b", "", connection.nickname),
    element("small", "", `${connection.displayName} · ${connection.provider}`),
  );

  const live = connection.health === "healthy";
  const health = element("span", `pill ${live ? "live" : "paused"}`);
  health.append(element("span", "led"), document.createTextNode(capitalize(connection.health)));

  const scopes = element("div", "conn-scopes");
  scopes.setAttribute("role", "group");
  scopes.setAttribute("aria-label", "Granted scopes");
  scopes.append(...connection.grantedScopes.map((scope) => {
    const chip = element("span", "cap", scopeLabel(scope));
    chip.title = scope;
    return chip;
  }));

  const actions = element("div", "conn-actions");
  for (const [action, label, variant] of [
    ["reauthorize", "Reauthorize", ""],
    ["revoke", "Revoke", ""],
    ["remove", "Remove", " stop"],
  ]) {
    const button = element("button", `btn sm${variant}`, label);
    button.type = "button";
    button.dataset.connectionAction = action;
    button.dataset.connectionId = connection.id;
    actions.append(button);
  }
  const feedback = element("span", "conn-feedback");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  actions.append(feedback);

  row.append(identity, health, scopes, actions);
  return row;
}

function custodyEmptyNotice(count, message) {
  // Honest empty state: the notice is returned ONLY when the list is genuinely
  // zero-length. A populated list returns null, so real data is never masked by
  // a false empty state. (Pure — unit-tested against zero and non-zero counts.)
  return count === 0 ? message : null;
}

function custodyStatusPatch(ok, message) {
  // Honest failure state: the status line always shows the message, but the live
  // Connection list is overwritten with it ONLY on failure (ok === false), so a
  // healthy load never blanks the real list. (Pure — unit-tested both ways.)
  return { status: message, listReplacement: ok === false ? message : null };
}

function reportCustodyStatus(message, ok) {
  // One custody status signal for the top-level Connections page. On failure the
  // same message also replaces the live Connection list, so the page fails
  // clearly instead of going blank, stale, or showing a false empty state. On
  // success renderProviderCustody has already repainted the real lists, so they
  // are left untouched.
  const patch = custodyStatusPatch(ok, message);
  document.querySelector("#custody-status").textContent = patch.status;
  const connectionList = document.querySelector("#provider-connection-list");
  if (connectionList !== null && patch.listReplacement !== null) {
    connectionList.replaceChildren(element("p", "form-note", patch.listReplacement));
  }
}

async function startProviderAuthorization(providerAppId, nickname) {
  const result = await fetchProvider("/api/connections/authorize", {
    method: "POST",
    body: JSON.stringify({ providerAppId, nickname }),
  });
  if (typeof result.authorizationUrl !== "string" || result.authorizationUrl === "") {
    throw new Error("Provider custody unavailable: authorization URL was invalid.");
  }
  window.location.assign(result.authorizationUrl);
}

async function mutateConnection(connectionId, action) {
  const path = `/api/connections/${encodeURIComponent(connectionId)}`;
  if (action === "reauthorize") {
    await startProviderAuthorizationForExisting(connectionId);
  } else if (action === "revoke") {
    await fetchProvider(`${path}/revoke`, { method: "POST", body: "{}" });
  } else if (action === "remove") {
    await fetchProvider(path, { method: "DELETE" });
  } else {
    throw new Error(`Provider custody unavailable: unsupported Connection action ${action}.`);
  }
  if (action !== "reauthorize") await loadProviderCustody();
}

// Per-action inline feedback with a per-ROW in-flight guard. Pressing an action
// locks the whole row (row.dataset.busy) and disables EVERY action button on it,
// so a rapid Revoke-then-Remove cannot fire concurrent mutations whose late
// failure would land in a detached, re-rendered live region. On success
// revoke/remove repaint the list (this row is replaced) and reauthorize
// redirects, so nothing is restored; on failure the button set is re-enabled in
// the finally block and the error is shown loud in this row's feedback slot — or,
// if a concurrent re-render already detached the row, on the shared status line
// so the failure is never written into an orphaned node. Request semantics are
// unchanged (mutateConnection owns all endpoints/bodies).
async function runConnectionAction(button) {
  const row = button.closest(".conn-row");
  if (row && row.dataset.busy === "true") return;
  const feedback = row ? row.querySelector(".conn-feedback") : null;
  const buttons = row ? [...row.querySelectorAll("[data-connection-action]")] : [button];
  if (row) row.dataset.busy = "true";
  for (const control of buttons) control.disabled = true;
  if (feedback) { feedback.className = "conn-feedback busy"; feedback.textContent = "Working…"; }
  try {
    await mutateConnection(button.dataset.connectionId, button.dataset.connectionAction);
  } catch (error) {
    const message = errorMessage(error);
    if (feedback && feedback.isConnected) {
      feedback.className = "conn-feedback fail";
      feedback.textContent = message;
    } else {
      document.querySelector("#custody-status").textContent = message;
    }
  } finally {
    if (row) delete row.dataset.busy;
    for (const control of buttons) { if (control.isConnected) control.disabled = false; }
    if (feedback && feedback.isConnected && feedback.className === "conn-feedback busy") {
      feedback.className = "conn-feedback";
      feedback.textContent = "";
    }
  }
}

async function startProviderAuthorizationForExisting(connectionId) {
  const result = await fetchProvider(`/api/connections/${encodeURIComponent(connectionId)}/reauthorize`, {
    method: "POST",
    body: "{}",
  });
  if (typeof result.authorizationUrl !== "string" || result.authorizationUrl === "") {
    throw new Error("Provider custody unavailable: reauthorization URL was invalid.");
  }
  window.location.assign(result.authorizationUrl);
}

async function runAction(action, environment, tool, connectionId) {
  if (!ACTIONS.has(action)) throw new Error(`Demo action failed: unsupported action ${action}.`);
  if (!ENVIRONMENTS.includes(environment)) throw new Error(`Demo action failed: invalid environment ${environment}.`);
  const angel = selectedAngel();
  const ready = angel.readyForProduction;
  const body = {
    angelId: selectedAngel().id,
    action,
    environment,
    ...(tool ? { tool } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(action === "promote" && ready !== null ? {
      stagedDeploymentId: ready.stagedDeploymentId,
      expectedDigest: ready.expectedDigest,
      bindings: ready.bindings,
    } : {}),
  };
  let response;
  try {
    response = await fetch("/api/demo/action", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Demo action failed: network request failed (${errorMessage(error)}).`);
  }
  if (!response.ok) throw new Error(`Demo action failed: HTTP ${response.status}.`);
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Demo action failed: response was not valid JSON (${errorMessage(error)}).`);
  }
  return validateDemoState(payload);
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

// Map a known app name to its brand-mark <symbol> id in the index.html sprite,
// or null when the app is unknown (caller renders a neutral lettered plate).
// Pure string→string|null so it can be unit-tested without a DOM.
function providerLogoSymbol(app) {
  const key = String(app == null ? "" : app).trim().toLowerCase();
  const map = {
    gmail: "logo-gmail",
    docs: "logo-gdocs",
    gdocs: "logo-gdocs",
    "google docs": "logo-gdocs",
    calendar: "logo-gcal",
    gcal: "logo-gcal",
    slack: "logo-slack",
    x: "logo-x",
    twitter: "logo-x",
    whatsapp: "logo-whatsapp",
    imessage: "logo-imessage",
    messages: "logo-imessage",
    telegram: "logo-telegram",
  };
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

// Build a provider brand-mark element: a white .plogo plate referencing the
// mapped Lucide-style brand <symbol>, or a neutral lettered plate for unknown
// apps. `size` is a plogo size modifier ("lg" | "sm" | "xs"). Later PRs call
// this to render provider logos across Home, the rail, and the detail header.
function providerLogo(app, size) {
  const symbol = providerLogoSymbol(app);
  if (symbol) {
    const span = element("span", "plogo" + (size ? " " + size : ""));
    span.innerHTML = '<svg><use href="#' + symbol + '"></use></svg>';
    return span;
  }
  const letter = (String(app == null ? "" : app).trim()[0] || "?").toUpperCase();
  return element("span", "plogo neutral" + (size ? " " + size : ""), letter);
}

function shortDigest(digest) {
  if (!digest) return "No active digest";
  const normalized = digest.replace(/^sha256:/, "");
  return `sha256:${normalized.slice(0, 8)}…${normalized.slice(-4)}`;
}

function versionLabel(version) {
  return version === null ? "No active Version" : `Version ${version}`;
}

// Both environment-labelled versions always render; readiness is appended,
// never substituted — dropping the labels would blur which environment owns
// which Version exactly when preview is ahead of production.
function homeVersionWedgeText(angel) {
  const versions = `prod ${versionLabel(angel.environments.production.version).toLowerCase()} · preview ${versionLabel(angel.environments.preview.version).toLowerCase()}`;
  const ready = angel.readyForProduction;
  return ready !== null ? `${versions} · Version ${ready.toVersion} ready for exact promotion` : versions;
}

function selectedAngel() {
  const angel = demoState.angels.find((candidate) => candidate.id === activeAngelId);
  if (angel === undefined) throw new Error(`Invalid demo state: selected Angel ${activeAngelId} is missing.`);
  return angel;
}

function connectionById(angel, connectionId) {
  const connection = angel.connections.find((candidate) => candidate.id === connectionId);
  if (connection === undefined) throw new Error(`Invalid demo state: Connection ${connectionId} is missing.`);
  return connection;
}

function tupleCount(environment) {
  return environment.tools.reduce((count, tool) => count + tool.connections.length, 0);
}

function availableCount(environment) {
  return environment.tools.reduce(
    (count, tool) => count + tool.connections.filter((connection) => connection.available).length,
    0,
  );
}


// ---------------------------------------------------------------------------
// Home shared projections. Every value here is derived from real demo state —
// production tools (app / group), the Angel's Connections, and the health
// logic below — never fabricated copy. The three density renderers (quiet /
// list / dashboard) reuse these so the same Angel reads consistently.
// ---------------------------------------------------------------------------

// Distinct apps this Angel exposes, from its production tools (falling back to
// its Connections when nothing is deployed). Sorted for a stable order.
function homeApps(angel) {
  const apps = new Set();
  for (const tool of angel.environments.production.tools) apps.add(tool.app);
  if (apps.size === 0) {
    for (const connection of angel.connections) for (const app of connection.apps) apps.add(app);
  }
  return [...apps].sort();
}

// Count of production tool bindings — the honest "Tools" figure.
function homeToolCount(angel) {
  return angel.environments.production.tools.length;
}

// app → (group → count) from the real production tools, mirroring the Allowed
// Tools pane's app → Read/Use projection.
function homeAppGroups(angel) {
  const byApp = new Map();
  for (const tool of angel.environments.production.tools) {
    const groups = byApp.get(tool.app) ?? new Map();
    groups.set(tool.group, (groups.get(tool.group) ?? 0) + 1);
    byApp.set(tool.app, groups);
  }
  return byApp;
}

// A provider brand-mark badge for one Angel: a single .plogo when it exposes one
// app, or an overlapping .mhead-logos cluster when it spans several.
function homeAppBadge(apps, size) {
  if (apps.length <= 1) return providerLogo(apps[0] ?? "", size);
  const cluster = element("span", "mhead-logos");
  for (const app of apps.slice(0, 3)) cluster.append(providerLogo(app, size));
  return cluster;
}

// Stable per-Angel accent colour (the dashboard card's --dc), chosen
// deterministically from the Angel id so a card keeps its colour across renders.
function angelAccent(id) {
  const palette = ["#285f89", "#3f7d52", "#a9762a", "#7b4bb3", "#b3452e", "#2f7d72"];
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return palette[hash % palette.length];
}

// Shorten a fully-qualified tool name to its trailing verb path for a .cap chip
// (gmail.users.messages.list → messages.list). Real tool names, never invented.
function shortToolName(name) {
  return name.split(".").slice(-2).join(".");
}

// The honest fleet-status pill, reusing angelHealthy(): a paused Angel reads
// Paused, a degraded one Attention (both loud), only a converged one reads Live.
function homeStatusPill(angel) {
  const healthy = angelHealthy(angel);
  const pill = element("span", `pill ${healthy ? "live" : "paused"}`);
  pill.append(
    element("span", "led"),
    document.createTextNode(!angel.enabled ? "Paused" : healthy ? "Live" : "Attention"),
  );
  return pill;
}

// Dashboard density: the prototype .dcard — accent bar, leading brand mark(s),
// name + provider line, status pill, real app → group tool rows, a wedged line
// carrying the real per-environment version / promotion-ready hint the mockup
// omits, then the real Connections strip.
function renderHomeAngel(angel) {
  const card = element("button", "dcard");
  card.type = "button";
  card.dataset.route = "angel";
  card.dataset.angelId = angel.id;
  card.style.setProperty("--dc", angelAccent(angel.id));
  card.append(element("div", "accent"));
  const body = element("div", "body");

  const apps = homeApps(angel);
  const top = element("div", "top");
  top.append(apps.length <= 1 ? providerLogo(apps[0] ?? "", "lg") : homeAppBadge(apps, "sm"));
  const identity = element("div", "dcard-id");
  identity.append(element("div", "nm", angel.name));
  const connectionCount = angel.connections.length;
  identity.append(element("div", "pv", apps.length > 1
    ? `${connectionCount} account${connectionCount === 1 ? "" : "s"} · ${apps.length} apps`
    : `${apps[0] ?? "No deployed tools"} · ${homeToolCount(angel)} tools`));
  top.append(identity, homeStatusPill(angel));
  body.append(top);

  const tools = element("div", "dtools");
  const appGroups = homeAppGroups(angel);
  const multiApp = appGroups.size > 1;
  let firstApp = true;
  for (const [app, groups] of appGroups) {
    if (multiApp) {
      const sub = element("div", `dsub${firstApp ? " first" : ""}`);
      sub.append(providerLogo(app, "xs"), document.createTextNode(app));
      tools.append(sub);
    }
    firstApp = false;
    for (const [group, count] of groups) {
      const row = element("div", "dtrow");
      row.append(
        element("span", "dic", "•"),
        element("span", "dnm", group),
        element("span", "cap", `${count} tool${count === 1 ? "" : "s"}`),
      );
      tools.append(row);
    }
  }
  body.append(tools);

  // Wedged: real info the prototype card lacks — the promotion-ready hint, or the
  // per-environment Version story (the product's exact-promotion backbone).
  const wedge = element("div", "wedge home-wedge");
  wedge.title = "Real deployment data: the Version deployed to production and to preview, plus the promotion-ready hint when a promotion is staged. The approved design mockup has no slot for this line yet, so it keeps this placeholder treatment until a designer places it. Context and next steps: docs/design/prototype-parity-handoff.md, section \"Wedge inventory\".";
  wedge.append(element("span", "wedge-tag", "not in the design yet"));
  wedge.append(document.createTextNode(` ${homeVersionWedgeText(angel)}`));
  body.append(wedge);

  body.append(renderHomeAccounts(angel.connections));
  card.append(body);
  return card;
}

// The real signed-in Connections strip (.daccts) — never fabricated accounts.
function renderHomeAccounts(connections) {
  const accounts = element("div", "daccts");
  accounts.append(element("div", "lab", `Accounts · ${connections.length}`));
  const list = element("div", "alist");
  for (const connection of connections.slice(0, 3)) {
    const item = element("span", "aitem");
    item.append(
      element("span", "av", (connection.label.replace(/[^a-z0-9]/i, "")[0] ?? "?").toUpperCase()),
      document.createTextNode(connection.label),
    );
    list.append(item);
  }
  if (connections.length > 3) {
    list.append(element("span", "aitem aitem-more", `+${connections.length - 3} more`));
  }
  accounts.append(list);
  return accounts;
}

function angelHealthy(angel) {
  // Derived health: an Angel is healthy only when it is enabled AND both
  // environments have aligned gates with no pending availability repair. All
  // signals come from real state; nothing is hardcoded.
  if (!angel.enabled) return false;
  for (const environment of Object.values(angel.environments)) {
    if (environment.gateAlignment.installation !== "aligned"
      || environment.gateAlignment.availability !== "aligned") return false;
    if (environment.pendingAvailabilityRepair !== null) return false;
  }
  return true;
}

function fleetHealthSummary(angels) {
  // Pure Home health rollup: attention count + display label, derived entirely
  // from angelHealthy(). Cannot be short-circuited to always-healthy without
  // failing the unit tests that execute it against gate-drifted / pending-repair
  // fixtures. (Pure — no DOM.)
  const total = angels.length;
  const noun = total === 1 ? "Angel" : "Angels";
  if (total === 0) return { total, attention: 0, label: "No Angels deployed yet" };
  const attention = angels.filter((angel) => !angelHealthy(angel)).length;
  const label = attention === 0
    ? `${total} ${noun} · all healthy`
    : `${total} ${noun} · ${attention} need${attention === 1 ? "s" : ""} attention`;
  return { total, attention, label };
}

function homeAngelRenderer(density) {
  // Pure density → renderer mapping (default quiet). (Unit-tested by executing
  // this with the three modes; a broken mapping fails the test.)
  if (density === "dashboard") return renderHomeAngel;
  if (density === "list") return renderHomeAngelList;
  return renderHomeAngelQuiet;
}

// Quiet density: the prototype .corow — a status dot, the Angel's brand mark(s),
// its name, and a right-aligned mono meta. The whole row is a real button so it
// is keyboard-reachable (the prototype's div was mouse-only).
function renderHomeAngelQuiet(angel) {
  const row = element("button", `corow${angel.enabled ? "" : " paused"}`);
  row.type = "button";
  row.dataset.route = "angel";
  row.dataset.angelId = angel.id;
  const healthy = angelHealthy(angel);
  row.append(element("span", `cdot ${healthy ? "live" : "paused"}`));
  row.append(homeAppBadge(homeApps(angel), "xs"));
  row.append(element("span", "cname", angel.name));
  const tools = homeToolCount(angel);
  row.append(element("span", "cmeta", `${tools} tool${tools === 1 ? "" : "s"}`));
  return row;
}

// List density: one prototype table.wf row — Angel / App / What it can do
// (real tool names as .cap chips) / Tools / Status. The first cell carries a
// bare button so the row is keyboard-operable as well as click-anywhere.
function renderHomeAngelList(angel) {
  const row = element("tr");
  row.dataset.route = "angel";
  row.dataset.angelId = angel.id;

  const nameCell = element("td", "nm");
  const open = element("button", "wf-open", angel.name);
  open.type = "button";
  open.dataset.route = "angel";
  open.dataset.angelId = angel.id;
  nameCell.append(open);
  row.append(nameCell);

  const apps = homeApps(angel);
  const appCell = element("td");
  const prov = element("span", "prov");
  prov.append(homeAppBadge(apps, "sm"), document.createTextNode(apps.length === 1 ? apps[0] : `${apps.length} apps`));
  appCell.append(prov);
  row.append(appCell);

  const capsCell = element("td");
  const caps = element("span", "wf-caps");
  const tools = angel.environments.production.tools;
  for (const tool of tools.slice(0, 3)) caps.append(element("span", "cap", shortToolName(tool.name)));
  if (tools.length > 3) caps.append(element("span", "cap cap-more", `+${tools.length - 3}`));
  capsCell.append(caps);
  row.append(capsCell);

  row.append(element("td", "mono", String(homeToolCount(angel))));

  const statusCell = element("td");
  statusCell.append(homeStatusPill(angel));
  row.append(statusCell);
  return row;
}

// ---------------------------------------------------------------------------
// WP4: zero-Angel getting-started guide + ANGEL.yaml groups explainer.
// The guide teaches the REAL operator journey documented in
// docs/google-read-proof-manual-journey.md; the explainer reuses WP1's
// groupToolsByApp / isReadOnlyTool / toolGuardCopy so its app → group folders
// are the SAME projection as the live Allowed Tools pane, never a parallel copy.
// ---------------------------------------------------------------------------

// Pure data: the real first-Angel journey. Browser vs. operator-shell steps
// mirror the doc's "Sam in a browser" / "Local operator shell" split. Every
// command is copied verbatim from the doc — no invented flags, no fabricated
// token values (credentials stay as the doc's `...` placeholders).
function newAngelGuideSteps() {
  const accessToken = "ANGEL_ACCESS_TOKEN='{\"cf-access-client-id\":\"...\",\"cf-access-client-secret\":\"...\"}'";
  return [
    {
      where: "browser",
      title: "Sign in through Cloudflare Access",
      detail: "Open the Access-protected control site and complete Cloudflare Access login for the M1 Account. Keep the browser session open for the custody screens and provider callback.",
      commands: [],
    },
    {
      where: "browser",
      title: "Add your BYO Google client",
      detail: "In Google Cloud Console select the OAuth client with the deployed callback URI and the read-only Gmail and Docs APIs, then add its client ID and secret as a Provider App on Connections. The secret is entered into the protected form only, never into this repository.",
      commands: [],
    },
    {
      where: "browser",
      title: "Authorize and name the Connection",
      detail: "Start a Google authorization for that Provider App, complete the read-only consent screen, and create the Connection with the nickname your deployment config uses. Confirm the selected Connection is healthy.",
      commands: [],
    },
    {
      where: "shell",
      title: "Copy the deployment config",
      detail: "Copy the safe example and edit only local deployment concerns — control target, Account, Angel slug, and the healthy Connection nickname under docs and gmail for both preview and production. The real angel.json is git-ignored; ANGEL.yaml stays portable.",
      commands: ["cp angels/google-read-proof/angel.example.json angels/google-read-proof/angel.json"],
    },
    {
      where: "shell",
      title: "Publish to preview",
      detail: "With the operator's management bearer and the mandatory Cloudflare Access service token for the Access-protected M1 Control endpoint, build the checked-in policy, publish its immutable artifact, and install the exact bindings in preview. Verify the tool list contains only gmail.users.messages.list and docs.documents.get.",
      commands: [`ANGEL_MANAGEMENT_TOKEN=... ${accessToken} bun run angel publish google-read-proof`],
    },
    {
      where: "shell",
      title: "Promote the exact staged deploy to production",
      detail: "With the same management bearer and mandatory ANGEL_ACCESS_TOKEN, promote the exact staged deployment. The command does not rebuild or republish.",
      commands: [`ANGEL_MANAGEMENT_TOKEN=... ${accessToken} bun run angel deploy google-read-proof --prod`],
    },
    {
      where: "shell",
      title: "Capture the shown-once production key",
      detail: "Save the production Angel key printed by the initial publish/ensure response into the GitHub Actions secret GOLDEN_ANGEL_KEY. Never paste it into a file, command transcript, issue, report, or chat.",
      commands: [],
    },
  ];
}

// The code side of the code ↔ render example: a REAL shipped policy, copied
// verbatim from angels/gmail-read-and-draft/ANGEL.yaml. It lists a guarded read,
// a plain read, and one Use-group draft create — enough to show both group kinds.
function angelYamlExampleSource() {
  return [
    "name: gmail-read-and-draft",
    "",
    "charter: Read bounded Gmail results and prepare drafts for review. Never send or delete mail.",
    "",
    "tools:",
    "  - tool: gmail.users.messages.list",
    "    argGuards:",
    "      - field: maxResults",
    "        pin: \"5\"",
    "  - gmail.users.messages.get",
    "  - gmail.users.drafts.create",
  ].join("\n");
}

// The rendered side: the same tool shape the demo-state producer emits (name /
// app / group / guards). appName maps gmail → "Gmail"; groupName sorts list/get
// into "Read" and create into "Use"; guardLabels renders the pinned maxResults.
function angelYamlExampleTools() {
  return [
    { name: "gmail.users.messages.list", app: "Gmail", group: "Read", guards: ["maxResults pinned to 5"] },
    { name: "gmail.users.messages.get", app: "Gmail", group: "Read", guards: [] },
    { name: "gmail.users.drafts.create", app: "Gmail", group: "Use", guards: [] },
  ];
}

function renderNewAngelGuide() {
  const panel = element("section", "panel wp4-guide");
  const head = element("div", "wp4-panel-head");
  head.append(element("span", "eyebrow", "Getting started"));
  head.append(element("b", "", "Publish your first Angel from the CLI"));
  head.append(element("small", "", "Get your first Angel live in production, following the real google-read-proof operator journey: sign in, add your BYO Google client, authorize a Connection, edit local config, publish to preview, promote to production, and capture the shown-once key. Browser steps use the Access-protected control site; shell steps run from your local operator checkout. Publish installs preview; deploy --prod promotes the exact staged build to production without rebuilding."));
  head.append(element("small", "wp4-guide-more", "From here, docs/google-read-proof-manual-journey.md continues with wiring the GitHub Actions secret and repository variables, running the acceptance journey, and proving the revoke/failure and reauthorization path."));
  panel.append(head);
  const list = element("ol", "wp4-steps");
  newAngelGuideSteps().forEach((step, index) => {
    const item = element("li", "wp4-step");
    item.append(element("span", "wp4-step-index", String(index + 1)));
    const body = element("div", "wp4-step-body");
    const titleLine = element("span", "wp4-step-title-line");
    titleLine.append(element("span", `wp4-step-where wp4-where-${step.where}`, step.where === "browser" ? "In a browser" : "Operator shell"));
    titleLine.append(element("b", "", step.title));
    body.append(titleLine);
    body.append(element("small", "", step.detail));
    for (const command of step.commands) {
      const pre = element("pre", "wp4-command");
      pre.append(element("code", "", command));
      body.append(pre);
    }
    item.append(body);
    list.append(item);
  });
  panel.append(list);
  return panel;
}

function renderAngelYamlExplainer() {
  const panel = element("section", "panel wp4-explainer");
  const head = element("div", "wp4-panel-head");
  head.append(element("span", "eyebrow", "Reference"));
  head.append(element("b", "", "How ANGEL.yaml becomes app → group folders"));
  head.append(element("small", "", "Your portable ANGEL.yaml lists tools by name. The Allowed Tools pane groups them by app, then by Read / Use — read operations (get / list) render read-only. This is the same projection shown on every Angel."));
  panel.append(head);
  const split = element("div", "wp4-explainer-split");
  const codeSide = element("div", "wp4-explainer-col");
  codeSide.append(element("span", "wp4-side-label", "ANGEL.yaml"));
  const pre = element("pre", "wp4-code");
  pre.append(element("code", "", angelYamlExampleSource()));
  codeSide.append(pre);
  const renderSide = element("div", "wp4-explainer-col");
  renderSide.append(element("span", "wp4-side-label", "Allowed Tools"));
  // Same renderer the live Allowed Tools pane uses — WITHOUT the connection
  // toggles (static reference), so the code ↔ render example can never drift
  // from the real pane.
  const card = element("div", "wp4-render-card");
  card.append(...renderToolFolders(angelYamlExampleTools(), { withControls: false }));
  renderSide.append(card);
  split.append(codeSide, renderSide);
  panel.append(split);
  return panel;
}

// The zero-Angel Home body: honest empty-state line (its copy is pinned by the
// pre-first-Angel test), then the CLI guide and the ANGEL.yaml explainer.
function renderZeroAngelGuide() {
  const intro = element("section", "panel empty-state wp4-empty-intro");
  intro.append(element("b", "", "No Angels are deployed yet"));
  intro.append(element("small", "", "Publish one from the CLI when its Connections are ready. The steps below get your first Angel live in production, following the real google-read-proof journey."));
  return [intro, renderNewAngelGuide(), renderAngelYamlExplainer()];
}

function renderHome() {
  document.querySelector("#account-name").textContent = demoState.account.name;
  document.querySelector("#home-account").textContent = demoState.account.name;
  const summary = fleetHealthSummary(demoState.angels);
  const noun = summary.total === 1 ? "Angel" : "Angels";
  document.querySelector("#home-summary").textContent = `${summary.total} hosted ${noun}, each isolated across preview and production.`;

  // Fleet health now leads on the LEFT as the prototype's .reassure line under
  // the h1 (the duplicate Fleet Health panel + top-right pill are gone). Degraded
  // fleets stay loud: the line switches to the warn treatment and an "!" badge.
  const healthLine = document.querySelector("#home-health-line");
  document.querySelector("#home-health").textContent = summary.label;
  healthLine.hidden = summary.total === 0;
  healthLine.classList.toggle("attention", summary.attention > 0);
  document.querySelector("#home-health-badge").textContent = summary.attention > 0 ? "!" : "✓";

  // Icon-only density toggle (Quiet / List / Dashboard) uses the prototype's .on
  // active class on its .seg.icons buttons.
  for (const button of document.querySelectorAll("#home-density [data-density]")) {
    button.classList.toggle("on", button.dataset.density === homeDensity);
  }

  const host = document.querySelector("#angel-list");
  host.className = `angel-list density-${homeDensity}`;
  if (summary.total === 0) {
    host.className = "angel-list wp4-zero-state";
    host.replaceChildren(...renderZeroAngelGuide());
    return;
  }

  // One shared per-Angel renderer per density (unit-tested mapping); the density
  // container it lives in differs — a centered ambient hero + narrow .collist for
  // quiet, a table.wf for list, a .dash-grid of cards for dashboard.
  const renderer = homeAngelRenderer(homeDensity);
  const cards = demoState.angels.map(renderer);
  if (homeDensity === "list") {
    const table = element("table", "wf");
    const headRow = element("tr");
    for (const label of ["Angel", "App", "What it can do", "Tools", "Status"]) {
      headRow.append(element("th", "", label));
    }
    const head = element("thead");
    head.append(headRow);
    const bodyRows = element("tbody");
    bodyRows.append(...cards);
    table.append(head, bodyRows);
    host.replaceChildren(table);
  } else if (homeDensity === "dashboard") {
    const grid = element("div", "dash-grid");
    grid.append(...cards);
    host.replaceChildren(grid);
  } else {
    const wrap = element("div", "amb-wrap");
    wrap.append(quietHeadline(summary));
    const list = element("div", "collist narrow");
    list.append(...cards);
    wrap.append(list);
    host.replaceChildren(wrap);
  }
}

// The quiet ambient hero: "N Angels. All healthy." with the good-coloured .ok
// span, swapping to the loud warn copy — "N Angels. K need attention." — the
// moment the real fleetHealthSummary reports any Angel needs attention.
function quietHeadline(summary) {
  const noun = summary.total === 1 ? "Angel" : "Angels";
  const line = element("p", "huge");
  line.append(document.createTextNode(`${summary.total} ${noun}. `));
  line.append(summary.attention === 0
    ? element("span", "ok", "All healthy.")
    : element("span", "warn", `${summary.attention} need${summary.attention === 1 ? "s" : ""} attention.`));
  return line;
}

// The distinct provider apps deployed in the ACTIVE environment only, sorted for
// a stable brand-mark cluster. Production must never surface a provider that only
// preview deploys, so the header derives its logos and charter from
// environments[activeEnvironment].tools — NOT a cross-environment union. When the
// active environment has no active Version (no tools), this is empty, so no logo
// is fabricated and the caller shows the honest empty label instead.
function activeEnvironmentApps(angel = selectedAngel()) {
  const apps = new Set();
  for (const tool of angel.environments[activeEnvironment].tools) apps.add(tool.app);
  return [...apps].sort();
}

// The angel rail rows, built as the prototype .rail-item idiom: a .dot-led whose
// live/paused class is driven by the REAL angel.enabled state, the angel name,
// and .sel on the active row. Kept as a returnable builder (not inlined) so the
// executed tests can walk the nodes and prove the dot state + selection.
function railItemNodes() {
  return demoState.angels.map((candidate) => {
    const item = element("button", `rail-item${candidate.id === activeAngelId ? " sel" : ""}`);
    item.type = "button";
    item.dataset.angelId = candidate.id;
    item.append(
      element("span", `dot-led ${candidate.enabled ? "live" : "paused"}`),
      element("span", "", candidate.name),
    );
    return item;
  });
}

function renderAngelHeading() {
  const angel = selectedAngel();
  document.querySelector("#angel-name").textContent = angel.name;
  // Charter + logos track the ACTIVE environment; an environment with no deployed
  // tools shows the honest empty label and no brand-marks (never a fabricated one).
  const apps = activeEnvironmentApps(angel);
  document.querySelector("#angel-charter").textContent = apps.length === 0
    ? "No tools are deployed to this environment yet."
    : `${apps.join(" + ")} hosted permissions with independent preview and production controls.`;
  // Overlapped provider brand-marks (prototype .mhead-logos cluster).
  document.querySelector("#angel-logos").replaceChildren(...apps.map((app) => providerLogo(app, "sm")));
  const status = document.querySelector("#angel-status");
  status.classList.toggle("live", angel.enabled);
  status.classList.toggle("paused", !angel.enabled);
  status.lastChild.textContent = angel.enabled ? "Live" : "Paused";
  document.querySelector("#angel-rail-list").replaceChildren(...railItemNodes());
  document.querySelector("#version-notification").hidden = angel.readyForProduction === null;
}

// The quiet header sub line: environment + Version only. The sha/digest is a
// back-office mechanical detail — it lives in Settings (Version history + the
// gate detail), never on the front door. Pure so a test can prove no sha leaks.
function environmentSubLine(environmentName, environment) {
  return `${environmentName} · ${versionLabel(environment.version)}`;
}

function renderEnvironmentSeam() {
  const environment = selectedAngel().environments[activeEnvironment];
  const envName = activeEnvironment === "production" ? "Production" : "Preview";
  document.querySelector("#angel-envline").textContent =
    environmentSubLine(envName, environment);
  // The compact segmented control replaces the environment tabs; keep the exact
  // per-environment switching semantics (the delegated [data-environment] handler).
  for (const tab of document.querySelectorAll("[data-environment]")) {
    const on = tab.dataset.environment === activeEnvironment;
    tab.classList.toggle("on", on);
    tab.setAttribute("aria-pressed", String(on));
  }
}

// One per-(tool, Connection) availability toggle, rendered as the prototype .tog
// switch. It keeps the exact action wiring the tests and click handler depend on:
// data-tool + data-connection-id + the pause_tool/resume_tool data-action, so a
// tap targets ONE tool and ONE Connection (pause_all stays environment-wide).
function renderConnectionToggle(tool, connection) {
  const identity = connectionById(selectedAngel(), connection.connectionId);
  const toggle = element("button", `tog sm${connection.available ? " on" : " off"}`);
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(connection.available));
  toggle.setAttribute("aria-label", `${connection.available ? "Pause" : "Resume"} ${tool.name} for ${identity.label} in ${activeEnvironment}`);
  toggle.dataset.tool = tool.name;
  toggle.dataset.connectionId = connection.connectionId;
  toggle.setAttribute("data-connection-id", connection.connectionId);
  toggle.dataset.action = connection.available ? "pause_tool" : "resume_tool";
  toggle.dataset.availabilityAction = "";
  return toggle;
}

function renderBindingMap(bindings) {
  const angel = selectedAngel();
  const review = element("section", "promotion-bindings");
  review.append(element("h3", "", "Production bindings"));
  for (const [requirementId, connectionIds] of Object.entries(bindings)) {
    const row = element("div", "binding-row");
    row.append(element("b", "", requirementId));
    const connections = element("span", "binding-connections");
    for (const connectionId of connectionIds) {
      const connection = connectionById(angel, connectionId);
      const chip = element("span", "binding-chip");
      chip.append(element("b", "", connection.label));
      connections.append(chip);
    }
    row.append(connections);
    review.append(row);
  }
  return review;
}

// Group the environment's canonical tools into an app → group folder tree using
// ONLY the real demo-state fields tool.app and tool.group. Insertion order is
// preserved (Map keeps first-seen order), so the folders are a deterministic
// projection of the producer's tool order — no client-side reshuffling.
function groupToolsByApp(tools) {
  const apps = new Map();
  for (const tool of tools) {
    if (!apps.has(tool.app)) apps.set(tool.app, new Map());
    const groups = apps.get(tool.app);
    if (!groups.has(tool.group)) groups.set(tool.group, []);
    groups.get(tool.group).push(tool);
  }
  return apps;
}

// A tool is read-only exactly when the producer sorted it into the "Read" group
// (get / list / getProfile operations). This is derived state, never asserted
// beyond what the group field already encodes.
function isReadOnlyTool(tool) {
  return tool.group === "Read";
}

// Pure state → banner-severity mapping for the availability banner. Kept out of
// renderPermissions so it can be unit-tested directly (no DOM): given an
// environment it derives every availability signal AND the two banner classes.
//   paused   → shown for ANY degraded/undeployed state (warn treatment)
//   critical → escalation to danger, ONLY for a DEPLOYED env that is frozen,
//              gate-drifting, or mid-repair; a merely partial or not-yet-deployed
//              env stays warn, never danger.
function availabilityBannerState(environment) {
  const count = availableCount(environment);
  const total = tupleCount(environment);
  const deployed = environment.version !== null && environment.deploymentId !== null;
  const allAvailable = deployed && total > 0 && count === total;
  const noneAvailable = deployed && count === 0;
  const gateAlignment = environment.gateAlignment;
  const gatesAligned = gateAlignment.installation === "aligned"
    && gateAlignment.availability === "aligned";
  const pendingRepair = environment.pendingAvailabilityRepair;
  const fullyConverged = gatesAligned && pendingRepair === null;
  return {
    count,
    total,
    deployed,
    allAvailable,
    noneAvailable,
    gateAlignment,
    gatesAligned,
    pendingRepair,
    fullyConverged,
    paused: !deployed || !allAvailable || !fullyConverged,
    critical: deployed && (noneAvailable || !gatesAligned || pendingRepair !== null),
  };
}

function renderPermissions() {
  const environment = selectedAngel().environments[activeEnvironment];
  const {
    count, total, deployed, allAvailable, noneAvailable,
    gateAlignment, gatesAligned, pendingRepair, fullyConverged, paused, critical,
  } = availabilityBannerState(environment);
  const banner = document.querySelector("#availability-banner");
  banner.classList.toggle("paused", paused);
  banner.classList.toggle("state-banner-critical", critical);
  const bannerCopy = element("span");
  const alignedTitle = allAvailable ? `${capitalize(activeEnvironment)} is live` : noneAvailable ? `${capitalize(activeEnvironment)} is frozen` : `${capitalize(activeEnvironment)} is partially available`;
  const mismatches = Object.entries(gateAlignment)
    .filter(([, state]) => state === "mismatched")
    .map(([dimension]) => dimension)
    .join(" and ");
  const alignedBannerTitle = pendingRepair !== null
    ? `${capitalize(activeEnvironment)} repair needs completion`
    : gatesAligned
    ? alignedTitle
    : `${capitalize(activeEnvironment)} gates need repair`;
  const bannerTitle = deployed
    ? alignedBannerTitle
    : `${capitalize(activeEnvironment)} is not deployed`;
  const bannerDetail = !deployed
    ? "No Version is deployed to this environment."
    : pendingRepair !== null
    ? "Pending availability repair must be retried."
    : gatesAligned
    ? `${versionLabel(environment.version)} · availability revision ${environment.availability.revision} · exact at both gates`
    : `${versionLabel(environment.version)} · ${mismatches} mismatch between gateway and broker`;
  bannerCopy.append(element("b", "", bannerTitle));
  bannerCopy.append(element("small", "", bannerDetail));
  const pill = element("span", `status-pill${deployed && allAvailable && fullyConverged ? "" : " paused"}`);
  const alignedStatus = allAvailable ? "Exact" : noneAvailable ? "Frozen" : "Partial";
  const deploymentStatus = deployed ? alignedStatus : "Not deployed";
  pill.append(element("span", "status-dot"), document.createTextNode(fullyConverged ? deploymentStatus : "Repairing"));
  const bannerActions = element("span", "button-row");
  bannerActions.append(pill);
  if (pendingRepair !== null) {
    const label = pendingRepair.action.replace("_", " ");
    const repair = element("button", "button compact", `Retry ${label}${"tool" in pendingRepair ? ` · ${pendingRepair.tool}` : ""}`);
    repair.type = "button";
    repair.dataset.action = pendingRepair.action;
    if ("tool" in pendingRepair) {
      repair.dataset.tool = pendingRepair.tool;
      if ("connectionId" in pendingRepair) repair.dataset.connectionId = pendingRepair.connectionId;
    }
    repair.dataset.repairAction = "";
    bannerActions.append(repair);
  }
  banner.replaceChildren(bannerCopy, bannerActions);
  // Healthy + exact needs no loud banner — the Live pill and the header version
  // line already say it. The banner shows ONLY when something is degraded (paused
  // is true for partial / frozen / drift / pending-repair / undeployed).
  banner.hidden = !paused;

  // The gate/availability mechanical numbers (gate alignment, N/N bindings, the
  // availability revision) are NOT on the front door — they moved to the quiet
  // Settings → Availability detail (renderSettings / gateDetailRows). The front
  // door keeps only genuine warnings via the loud banner above.

  // Provider:account cards, built by the ONE shared renderer (below). The live
  // pane renders it WITH the per-tool/per-connection toggles; the ANGEL.yaml
  // explainer calls the SAME renderer without controls, so the two cannot drift.
  document.querySelector("#tool-list").replaceChildren(
    ...renderToolFolders(environment.tools, { withControls: true }),
  );
}

// Split a dotted tool name into its receding namespace and its highlighted leaf
// verb — the prototype .t-ns / .t-leaf treatment. Pure string→{namespace, leaf}
// so it unit-tests without a DOM: "gmail.users.messages.list" →
// { namespace: "gmail.users.messages.", leaf: "list" }; a bare name is all leaf.
function toolNameParts(name) {
  const value = String(name);
  const index = value.lastIndexOf(".");
  return index < 0
    ? { namespace: "", leaf: value }
    : { namespace: value.slice(0, index + 1), leaf: value.slice(index + 1) };
}

function toolNameLine(name) {
  const { namespace, leaf } = toolNameParts(name);
  const line = element("span", "mtn");
  if (namespace) line.append(element("span", "t-ns", namespace));
  line.append(element("span", "t-leaf", leaf));
  return line;
}

// One tool row (prototype .mtool). A guarded tool becomes an expandable .tool-g
// with the amber ARG GUARDS pill; its detail lines come from the real tool.guards
// strings. `connectionId` scopes the availability toggle to THIS card's Connection
// (null in the static explainer, which renders no toggle).
function renderToolRow(tool, connectionId) {
  const binding = connectionId === null
    ? null
    : tool.connections.find((connection) => connection.connectionId === connectionId);
  const toggle = binding ? renderConnectionToggle(tool, binding) : null;
  if (tool.guards.length === 0) {
    const row = element("div", "mtool");
    row.append(toolNameLine(tool.name));
    if (toggle) row.append(toggle);
    return row;
  }
  const wrap = element("div", "tool-g");
  const head = element("div", "tg-head mtool");
  head.append(toolNameLine(tool.name));
  head.append(element("span", "guard-pill", `${tool.guards.length} arg guard${tool.guards.length > 1 ? "s" : ""}`));
  if (toggle) head.append(toggle);
  const detail = element("div", "tg-detail");
  for (const guard of tool.guards) {
    const item = element("div", "guard-item");
    const kv = element("div", "gi-kv");
    const space = String(guard).indexOf(" ");
    if (space > 0) {
      kv.append(element("span", "gi-field", String(guard).slice(0, space)));
      kv.append(document.createTextNode(" "));
      kv.append(element("span", "gi-op", String(guard).slice(space + 1)));
    } else {
      kv.append(element("span", "gi-field", String(guard)));
    }
    item.append(kv);
    detail.append(item);
  }
  wrap.append(head, detail);
  return wrap;
}

// One group row set inside a provider card (prototype .mgrp). The count reads
// "N read" for a read-only group (every tool isReadOnlyTool) and "N allowed"
// otherwise — the exact prototype phrasing over the REAL group name + size.
function renderToolGroup(group, groupTools, connectionId, open) {
  const wrap = element("div", `mgrp${open ? " open" : ""}`);
  const head = element("div", "mgrp-head");
  head.append(element("span", "mgrp-mk", "•"));
  head.append(element("span", "mgrp-nm", group));
  const readOnly = groupTools.every(isReadOnlyTool);
  head.append(element("span", "mgrp-ct", `${groupTools.length} ${readOnly ? "read" : "allowed"}`));
  head.append(element("span", "mgrp-chev", "▸"));
  const tools = element("div", "mgrp-tools");
  for (const tool of groupTools) tools.append(renderToolRow(tool, connectionId));
  wrap.append(head, tools);
  return wrap;
}

// One provider:account card (prototype .mprov). Read-only providers carry the
// head .ro-badge (instead of per-tool badges). `connection` is a { connectionId,
// nickname, identity } descriptor whose nickname + account fold the old Active
// bindings mapping into the head .ps2 line; it is null in the static explainer.
function renderProviderCard(app, connection, groups) {
  const card = element("div", "mprov open");
  const head = element("div", "mprov-head");
  head.append(providerLogo(app, "sm"));
  const id = element("div", "mprov-id");
  const name = element("div", "pn2");
  name.append(document.createTextNode(app));
  const allTools = [...groups.values()].flat();
  if (allTools.length > 0 && allTools.every(isReadOnlyTool)) {
    name.append(element("span", "ro-badge", "read-only"));
  }
  id.append(name);
  if (connection !== null) {
    id.append(element("div", "ps2", `${connection.nickname} · ${connection.identity}`));
  }
  head.append(id);
  head.append(element("span", "mprov-right", `${allTools.length} ${allTools.length === 1 ? "tool" : "tools"}`));
  head.append(element("span", "mprov-chev", "▸"));
  const body = element("div", "mprov-body");
  let first = true;
  for (const [group, groupTools] of groups) {
    body.append(renderToolGroup(group, groupTools, connection === null ? null : connection.connectionId, first));
    first = false;
  }
  card.append(head, body);
  return card;
}

// Ordered provider:account buckets for the live pane — one card per (app,
// Connection) pair; a tool bound to several Connections appears under each. The
// in-card app→group projection reuses groupToolsByApp so the grouping stays
// single-sourced with the explainer.
function providerAccountFolders(tools) {
  const angel = selectedAngel();
  const buckets = new Map();
  for (const tool of tools) {
    for (const binding of tool.connections) {
      const key = JSON.stringify([tool.app, binding.connectionId]);
      if (!buckets.has(key)) {
        buckets.set(key, {
          app: tool.app,
          connection: {
            connectionId: binding.connectionId,
            nickname: connectionById(angel, binding.connectionId).label,
            identity: binding.identity,
          },
          tools: [],
        });
      }
      buckets.get(key).tools.push(tool);
    }
  }
  return [...buckets.values()].map((bucket) => ({
    app: bucket.app,
    connection: bucket.connection,
    groups: groupToolsByApp(bucket.tools).get(bucket.app),
  }));
}

// The single provider → group → tool renderer shared by the live Allowed Tools
// pane and the ANGEL.yaml explainer. Grouping (groupToolsByApp), read-only badges
// (isReadOnlyTool), and tool-name colouring (toolNameParts) all derive from real
// tool fields — no fabricated structure. `withControls` selects the live pane's
// provider:account cards WITH per-Connection toggles vs. the static explainer's
// one-card-per-app, toggle-free preview of the same component.
function renderToolFolders(tools, options) {
  const withControls = options?.withControls ?? true;
  if (!withControls) {
    return [...groupToolsByApp(tools)].map(([app, groups]) => renderProviderCard(app, null, groups));
  }
  return providerAccountFolders(tools).map(({ app, connection, groups }) => renderProviderCard(app, connection, groups));
}

function renderConnections() {
  const rows = selectedAngel().connections.map((connection) => {
    const row = element("div", "connection-row");
    const copy = element("span");
    copy.append(element("b", "", connection.label));
    const scopes = element("span", "scope-list");
    scopes.append(...connection.apps.map((app) => element("span", "scope-chip", app)));
    copy.append(element("small", "", "Provider access"), scopes);
    const health = element("span", `status-pill${connection.health === "healthy" ? "" : " paused"}`);
    health.append(element("span", "status-dot"), document.createTextNode(capitalize(connection.health)));
    row.append(copy, health);
    return row;
  });
  document.querySelector("#connection-list").replaceChildren(...(rows.length === 0
    ? [element("p", "empty-state", "No Connections are available to this Angel.")]
    : rows));
}

// The back-office gate/availability mechanical detail, relocated off the front
// door. Pure state → definition rows [{term, value}] from the SAME real fields
// the retired header gate chip rendered: gate alignment (Exact / per-gate
// mismatch), N/N bindings available, and the availability revision. Quiet and
// honest — never red, never a wedge. Testable without a DOM.
function gateDetailRows(environment) {
  const state = availabilityBannerState(environment);
  const { count, total, deployed, allAvailable, noneAvailable, gatesAligned, gateAlignment } = state;
  const gateState = !deployed ? "Not deployed" : noneAvailable ? "Frozen" : allAvailable ? "Exact" : "Partial";
  const alignment = gatesAligned
    ? gateState
    : Object.entries(gateAlignment)
        .filter(([, value]) => value === "mismatched")
        .map(([dimension]) => `${dimension} mismatched`)
        .join(", ");
  return [
    { term: "Gate alignment", value: alignment },
    { term: "Bindings available", value: `${count} / ${total}` },
    { term: "Availability revision", value: String(environment.availability.revision) },
  ];
}

function renderSettings() {
  // WP2 Settings holds ONLY backed content: environment pause/resume (the same
  // pause_all/resume_all actions) and the immutable Version history relocated
  // from the retired Versions tab. No rename/remove/export — the backend has no
  // such actions, so no such controls exist here. PR G also relocates the
  // gate/availability mechanical detail here (off the front door).
  const angel = selectedAngel();
  const environment = angel.environments[activeEnvironment];
  const count = availableCount(environment);
  const total = tupleCount(environment);
  document.querySelector("#settings-availability-summary").textContent =
    `${count} of ${total} tool bindings available in ${activeEnvironment}`;
  document.querySelector("#settings-availability-note").textContent =
    "Pausing changes runtime availability only; it never edits or republishes the deployed Version.";

  // Quiet mechanical detail — the numbers the front-door gate chip used to carry.
  const detail = gateDetailRows(environment).flatMap(({ term, value }) => [
    element("dt", "", term),
    element("dd", "", value),
  ]);
  document.querySelector("#settings-gate-detail").replaceChildren(...detail);

  const versions = [...angel.versions]
    .sort((left, right) => right.number - left.number)
    .map((version) => {
      const row = element("div", "version-row");
      const copy = element("span");
      copy.append(
        element("b", "", version.label),
        element("small", "", `${version.tools.length} tools`),
        // Full immutable digest — the front door dropped the sha, so the complete
        // value lives here (mono, wrappable) rather than only truncated.
        element("code", "version-digest", version.digest),
      );
      const status = element("span", `status-pill${version.status === "history" ? " paused" : ""}`, capitalize(version.status));
      row.append(element("span", "version-number", `V${version.number}`), copy, status);
      return row;
    });
  document.querySelector("#settings-versions-list").replaceChildren(...(versions.length === 0
    ? [element("p", "empty-state", "No Versions have been published for this Angel.")]
    : versions));
}

// The backend fingerprint is a 12-hex-char PUBLIC hash prefix (never the secret).
// Echo the prototype's masked idiom with an honest short suffix; the full public
// fingerprint is always available via the row's title attribute (see renderKeyRow).
// Pure string→string so it can be unit-tested without a DOM.
function maskFingerprint(fingerprint) {
  const value = String(fingerprint == null ? "" : fingerprint);
  return value.length <= 3 ? value : `••••${value.slice(-3)}`;
}

// A Lucide sprite icon for a button: a wrapper span whose inner <svg class="icon">
// is sized by the `.btn .icon` rule. Mirrors providerLogo()'s innerHTML idiom so
// it renders identically under the executed-DOM test stub.
function iconSvg(symbol) {
  const wrap = element("span", "icon-wrap");
  wrap.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${symbol}"></use></svg>`;
  return wrap;
}

// Recompose the Agent Keys pane to the prototype: a "MCP endpoint" tok-card + an
// "Agent keys" tok-card listing the ACTIVE environment's keys as .tokrows. Keys
// belong to the active environment, so switching environments re-renders.
function renderKeys() {
  const host = document.querySelector("#keys-host");
  if (host === null) return;
  const angel = selectedAngel();
  const environment = angel.environments[activeEnvironment];
  host.replaceChildren(renderEndpointCard(angel), renderAgentKeysCard(environment.keys));
}

function renderEndpointCard(angel) {
  const card = element("div", "tok-card");
  card.append(element("div", "th", "MCP endpoint"));
  const code = element("div", "code");
  code.append(element("span", "c", "# paste into your agent's MCP client"));
  // endpoints is a required first-class field; keep the copy honest to the ACTIVE
  // environment (a preview endpoint is never presented as production).
  code.append(document.createTextNode(`\n${angel.endpoints?.[activeEnvironment] ?? "Endpoint assigned after deployment"}`));
  card.append(code);
  card.append(element("p", "key-env-note", KEY_ENVIRONMENT_COPY));
  return card;
}

function renderAgentKeysCard(keys) {
  const card = element("div", "tok-card");
  card.append(element("div", "th", "Agent keys"));
  const active = keys.filter((key) => key.status === "active");
  const revoked = keys.filter((key) => key.status === "revoked");
  // The backend guarantees >= 1 active key via migration, but render an honest
  // empty state rather than assume it.
  if (active.length === 0) {
    card.append(element("p", "key-empty", `No active keys in ${activeEnvironment}.`));
  } else {
    for (const key of active) card.append(renderKeyRow(key));
  }
  // Revoked keys stay visible for history but are dimmed/struck and carry NO
  // actions — never shown as usable.
  if (revoked.length > 0) card.append(renderRevokedGroup(revoked));
  if (keyError !== null) card.append(element("p", "key-error", keyError));
  // The one-time reveal renders ONLY in the environment/angel it was minted for
  // (finding #3: a production secret never paints as a preview key). It is CONSUMED
  // on its single paint (finding #4: cleared here so any later render — ordinary or
  // post-navigation — shows nothing, without relying on a manual reset). A reveal
  // minted while the operator was on another context stays held until they return
  // to that context, then paints once and clears.
  if (keyReveal !== null && keyReveal.angelId === selectedAngel().id && keyReveal.environment === activeEnvironment) {
    card.append(renderReveal(keyReveal));
    keyReveal = null;
  }
  card.append(renderNewKeyControl());
  return card;
}

// One active-key row. Existing keys get NO Copy action: a fingerprint is useless
// for auth and the plaintext is unavailable post-mint (Copy lives only next to the
// one-time reveal). Rotate + Revoke only.
function renderKeyRow(key) {
  const row = element("div", "tokrow");
  row.append(element("span", "tn", key.name));
  const fingerprint = element("span", "tk", maskFingerprint(key.fingerprint));
  fingerprint.title = key.fingerprint;
  row.append(fingerprint);
  row.append(keyActionButton("rotate_key", key.id, "icon-rotate-cw", "Rotate", ""));
  row.append(keyActionButton("revoke_key", key.id, "icon-ban", "Revoke", " stop"));
  return row;
}

function keyActionButton(action, keyId, icon, label, extra) {
  const button = element("button", `btn sm${extra}`);
  button.type = "button";
  button.dataset.keyAction = action;
  button.dataset.keyId = keyId;
  button.append(iconSvg(icon), document.createTextNode(label));
  button.disabled = keysBusy;
  return button;
}

function renderRevokedGroup(revoked) {
  const group = element("div", "key-revoked-group");
  group.append(element("div", "key-revoked-head", `Revoked (${revoked.length})`));
  for (const key of revoked) {
    const row = element("div", "tokrow key-revoked-row");
    row.append(element("span", "tn", key.name));
    const fingerprint = element("span", "tk", maskFingerprint(key.fingerprint));
    fingerprint.title = key.fingerprint;
    row.append(fingerprint);
    row.append(element("span", "key-revoked-tag", "revoked"));
    group.append(row);
  }
  return group;
}

// The one-time plaintext reveal. The secret lives only in this rendered node (and
// the module-level keyReveal that produced it); it is never stored elsewhere and
// vanishes on the next navigation/re-render.
function renderReveal(reveal) {
  const block = element("div", "key-reveal");
  block.append(element("div", "th", `New key: ${reveal.name}`));
  block.append(element("p", "key-reveal-warn", "Save it now — it will not be shown again."));
  const code = element("div", "code");
  code.dataset.keyPlaintext = "";
  code.textContent = reveal.plaintext;
  block.append(code);
  const copy = element("button", "btn sm primary");
  copy.type = "button";
  copy.dataset.keyAction = "copy_plaintext";
  copy.append(iconSvg("icon-copy"), document.createTextNode("Copy"));
  block.append(copy);
  return block;
}

function renderNewKeyControl() {
  if (!newKeyFormOpen) {
    const wrap = element("div", "key-new");
    const button = element("button", "btn sm primary");
    button.type = "button";
    button.dataset.keyAction = "open_new";
    button.append(iconSvg("icon-plus"), document.createTextNode("New key"));
    button.disabled = keysBusy;
    wrap.append(button);
    return wrap;
  }
  const form = element("form", "key-new-form");
  const input = element("input", "key-new-input");
  input.type = "text";
  input.name = "keyName";
  input.placeholder = "Key name";
  input.setAttribute("aria-label", "New key name");
  input.disabled = keysBusy;
  const create = element("button", "btn sm primary", "Create");
  create.type = "submit";
  create.disabled = keysBusy;
  const cancel = element("button", "btn sm", "Cancel");
  cancel.type = "button";
  cancel.dataset.keyAction = "cancel_new";
  cancel.disabled = keysBusy;
  form.append(input, create, cancel);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (name === "") {
      keyError = "Enter a key name.";
      renderKeys();
      return;
    }
    void performKeyMutation("create_key", { name });
  });
  return form;
}

function handleKeyAction(action, keyId) {
  if (action === "open_new") { newKeyFormOpen = true; keyError = null; renderKeys(); return; }
  if (action === "cancel_new") { newKeyFormOpen = false; keyError = null; renderKeys(); return; }
  if (action === "copy_plaintext") { copyKeyPlaintext(); return; }
  if (action === "rotate_key" || action === "revoke_key") void performKeyMutation(action, { keyId });
}

// Perform a key mutation against the demo surface, disabling row actions in flight
// and restoring them in a finally. The angel + environment are CAPTURED at dispatch
// (finding #3) so a mid-flight environment/angel switch can never paint a
// production secret as a preview key; the reveal is tagged with that captured
// context and only paints there. A single client idempotency token (finding #2) is
// generated per attempt and reused across the retry inside requestKeyMutation, so a
// committed-but-lost mutation replays instead of minting a duplicate. Revoke
// surfaces the backend's guards (e.g. the last-active-key 409) honestly inline.
async function performKeyMutation(action, payload) {
  const angel = selectedAngel();
  const context = { angelId: angel.id, environment: activeEnvironment, name: angel.name };
  const idempotencyToken = keyIdempotencyToken();
  keysBusy = true;
  keyError = null;
  renderKeys();
  try {
    const result = await requestKeyMutation(action, context, payload, idempotencyToken);
    // Persist the one-time plaintext into module state IMMEDIATELY — BEFORE the
    // list refresh — so a failed refresh can never discard it (finding #1). The key
    // already exists server-side; the operator must still be able to copy it.
    if (action !== "revoke_key") {
      keyReveal = { angelId: context.angelId, environment: context.environment, name: result.key.name, plaintext: result.plaintext };
    }
    try {
      demoState = await loadState();
      newKeyFormOpen = false;
    } catch (refreshError) {
      // The mutation committed; only the refresh failed. Keep the reveal painted and
      // surface the refresh failure separately (loud, inline).
      keyError = `Key ${action === "revoke_key" ? "revoked" : "saved"}, but refreshing the list failed: ${errorMessage(refreshError)}`;
    }
    if (action !== "revoke_key") {
      const stillHere = context.angelId === selectedAngel().id && context.environment === activeEnvironment;
      showToast(stillHere
        ? keyActionToast(action, result)
        : `Key "${result.key.name}" ready for ${context.name} · ${capitalize(context.environment)} — open that environment to copy its one-time secret.`);
    } else {
      showToast(keyActionToast(action, result));
    }
  } catch (error) {
    keyError = errorMessage(error);
  } finally {
    keysBusy = false;
    renderKeys();
  }
}

// A per-attempt idempotency token. crypto.randomUUID is the browser default;
// fall through to a timestamp+random token if it is somehow unavailable.
function keyIdempotencyToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `tok_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function requestKeyMutation(action, context, payload, idempotencyToken) {
  const body = { angelId: context.angelId, action, environment: context.environment, ...payload, idempotencyToken };
  // Retry ONCE on an ambiguous network failure, REUSING the same idempotency token
  // so a committed-but-lost mutation replays (recovering the one-time plaintext)
  // instead of minting a duplicate. A definitive HTTP error is never retried.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch("/api/demo/action", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt === 0) continue;
      throw new Error(`Key request failed: network request failed (${errorMessage(error)}).`);
    }
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const failure = await response.json();
        if (failure && typeof failure.error === "string") message = failure.error;
      } catch { /* keep the status-code message */ }
      throw new Error(`Key request failed: ${message}.`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`Key request failed: response was not valid JSON (${errorMessage(error)}).`);
    }
  }
  throw new Error("Key request failed: network request failed after retry.");
}

function keyActionToast(action, result) {
  if (action === "create_key") return `Key "${result.key.name}" created.`;
  if (action === "rotate_key") return `Key "${result.key.name}" rotated.`;
  return "Key revoked.";
}

function copyKeyPlaintext() {
  const node = document.querySelector("[data-key-plaintext]");
  if (node === null) return;
  const text = node.textContent;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text)
      .then(() => showToast("Key copied — store it now."))
      .catch(() => selectNodeContents(node));
  } else {
    selectNodeContents(node);
  }
}

// Visible recovery path when the clipboard API is unavailable/denied: select the
// reveal .code contents so the reader can copy with the keyboard, no deprecated
// document command shims.
function selectNodeContents(node) {
  const selection = window.getSelection ? window.getSelection() : null;
  if (selection === null || typeof document.createRange !== "function") return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  showToast("Key selected — press ⌘/Ctrl+C to copy.");
}

// Reset the inline form + inline error on navigation. The one-time reveal is NOT
// force-cleared here: it is consumed on its single paint (renderAgentKeysCard) and
// otherwise stays tagged to its captured angel/environment so it can route to the
// correct context if the operator navigates back (findings #3/#4).
function resetKeysPaneTransient() {
  keyError = null;
  newKeyFormOpen = false;
}

function decisionClass(decision) {
  return decision.replace("_", "-");
}

function renderReceipt(label, receipt) {
  const card = element("div", `receipt${!receipt || receipt.decision !== "allow" ? " deny" : ""}`);
  card.append(element("small", "", label));
  if (!receipt) {
    card.append(element("b", "", "Not reached"), element("span", "", "No credential decision was needed."));
  } else {
    card.append(element("b", "", receipt.decision.replace("_", " ")), element("span", "", shortDigest(receipt.digest)));
  }
  return card;
}

function renderActivityDetail(event) {
  const host = document.querySelector("#activity-detail");
  if (!event) {
    host.replaceChildren(element("h2", "", "No activity in this environment"), element("p", "activity-meta", "Actions and requests appear here without crossing the environment boundary."));
    return;
  }
  const title = element("h2", "", event.tool);
  const meta = element("p", "activity-meta", `${event.requestId} · ${capitalize(event.environment)} · ${event.detail}`);
  const receipts = element("div", "receipts");
  receipts.append(renderReceipt("Public decision", event.gateway), renderReceipt("Credential decision", event.broker));
  host.replaceChildren(title, meta, receipts);
}

// Fill an environment badge host (dot + capitalized name) for the ACTIVE
// environment only. Each stratum carries its own badge so the reader always sees
// which environment the feed belongs to — preview and production never blend.
function paintEnvironmentBadge(host) {
  if (host === null) return host;
  host.className = `environment-badge ${activeEnvironment}`;
  host.replaceChildren(
    element("span", `environment-dot ${activeEnvironment}`),
    element("span", "", capitalize(activeEnvironment)),
  );
  return host;
}

function lifecycleLabel(kind) {
  if (kind === "version_published") return "Version published";
  if (kind === "preview_deploy") return "Deployed to preview";
  if (kind === "production_deploy") return "Deployed to production";
  return "Promoted to production";
}

// Stratum 1 — the pinned "Needs decision" card. It relocates the promotion panel
// here as the living signal of "a human decision is needed", reusing the exact
// promote/repair action controls. The staged→production promotion is a PRODUCTION
// decision, so it only ever surfaces in the production feed; the per-environment
// gate repair surfaces in its own environment. The two never interleave.
function renderDecisionCard() {
  const angel = selectedAngel();
  const environment = angel.environments[activeEnvironment];
  const ready = angel.readyForProduction;
  const repair = environment.pendingAvailabilityRepair;
  const gatesAligned = environment.gateAlignment.installation === "aligned"
    && environment.gateAlignment.availability === "aligned";
  const promotable = activeEnvironment === "production" && ready !== null;
  // Loud whenever a human decision OR a degraded gate needs attention. A pending
  // repair or a mismatched gate must never fall through to the calm resting card.
  const degraded = repair !== null || !gatesAligned;
  const host = document.querySelector("#decision-card");
  host.classList.toggle("needs-decision", promotable || degraded);
  host.classList.toggle("resting", !promotable && !degraded);
  const badge = paintEnvironmentBadge(element("span", "environment-badge"));

  // Priority order: a pending repair, then gate drift, OUTRANK promotion. The
  // backend rejects (409) a promote while an availability repair is pending, and
  // drifted gates block promotion too — so we surface the action the operator
  // actually needs instead of an enabled promote button that would fail.
  if (repair !== null) {
    const eyebrow = element("span", "decision-eyebrow", "Needs decision");
    const title = element("h2", "", `${capitalize(activeEnvironment)} gate repair needs completion`);
    const copy = element("p", "", "A prior availability change did not converge at both gates. Retry it before any further change or promotion.");
    const label = repair.action.replace("_", " ");
    const button = element("button", "button compact", `Retry ${label}${"tool" in repair ? ` · ${repair.tool}` : ""}`);
    button.type = "button";
    button.dataset.action = repair.action;
    if ("tool" in repair) {
      button.dataset.tool = repair.tool;
      if ("connectionId" in repair) button.dataset.connectionId = repair.connectionId;
    }
    button.dataset.repairAction = "";
    host.replaceChildren(eyebrow, badge, title, copy, button);
  } else if (!gatesAligned) {
    const mismatches = Object.entries(environment.gateAlignment)
      .filter(([, state]) => state === "mismatched")
      .map(([dimension]) => dimension)
      .join(" and ");
    const eyebrow = element("span", "decision-eyebrow", "Attention required");
    const title = element("h2", "", `${capitalize(activeEnvironment)} gates need repair`);
    const copy = element("p", "", `${capitalize(mismatches)} mismatch between the gateway and broker. Availability changes and promotion are blocked until the gates converge.`);
    host.replaceChildren(eyebrow, badge, title, copy);
  } else if (promotable) {
    const eyebrow = element("span", "decision-eyebrow", "Needs decision");
    const title = element("h2", "", `Version ${ready.toVersion} is staged and ready for production`);
    const copy = element("p", "", "Promote the exact artifact you tested. This does not build, republish, or rotate the production key.");
    const flow = element("div", "promotion-flow");
    const preview = element("div", "promotion-side");
    preview.append(element("small", "", "Preview · active"), element("b", "", `Version ${ready.toVersion}`), element("code", "", shortDigest(ready.expectedDigest)));
    const production = element("div", "promotion-side");
    production.append(element("small", "", "Production · current"), element("b", "", versionLabel(ready.fromVersion)), element("code", "", shortDigest(angel.environments.production.digest)));
    flow.append(preview, element("span", "promotion-arrow", "→"), production);
    const note = element("div", "exact-note", `Production receives staged deployment ${ready.stagedDeploymentId} and exact digest ${shortDigest(ready.expectedDigest)}.`);
    const bindings = renderBindingMap(ready.bindings);
    const diff = element("div", "version-diff");
    for (const tool of ready.diff.added) diff.append(element("span", "added", "+"), element("code", "", tool), element("span", "added", "added"));
    for (const tool of ready.diff.removed) diff.append(element("span", "", "−"), element("code", "", tool), element("span", "", "removed"));
    if (ready.diff.added.length === 0 && ready.diff.removed.length === 0) {
      diff.append(element("span", "", "="), element("span", "", "Tool allowlist"), element("span", "", "unchanged"));
    }
    const action = document.querySelector("#promote-action-template").content.firstElementChild.cloneNode(true);
    host.replaceChildren(eyebrow, badge, title, copy, flow, note, bindings, diff, action);
  } else {
    const eyebrow = element("span", "decision-eyebrow calm", "All clear");
    const title = element("h2", "", "No decision needs your attention");
    const copy = element("p", "", "Nothing in this environment is waiting on a human. Promotions and gate repairs will surface here.");
    host.replaceChildren(eyebrow, badge, title, copy);
  }
}

// Stratum 2 — deploys/versions. WP3 records NO wall-clock: every lifecycle event
// is source:"derived" with at:null. The only trustworthy ordering signal is the
// integer `order`, so we render an ordinal step ("Step N") and NEVER fabricate a
// timestamp or an "X ago". A genuine recorded event (non-null ISO `at`) is shown
// honestly if one ever appears; a derived event is labelled un-timed.
// Render a recorded ISO instant as a compact, unambiguous UTC label. We show the
// backend's genuine recorded time in UTC (never a fabricated "X ago"); if the
// string does not parse as a date we show it verbatim rather than invent one.
function formatRecordedAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function renderLifecycle() {
  const events = [...selectedAngel().environments[activeEnvironment].lifecycle]
    .sort((left, right) => left.order - right.order);
  const rows = events.map((event) => {
    const row = element("div", "lifecycle-row");
    const step = element("span", "lifecycle-step", `Step ${event.order + 1}`);
    const copy = element("span");
    copy.append(
      element("b", "", lifecycleLabel(event.kind)),
      element("small", "", `Version ${event.version}${event.deploymentId ? ` · ${event.deploymentId}` : ""}`),
    );
    const when = event.source === "recorded" && event.at !== null
      ? element("small", "lifecycle-at", formatRecordedAt(event.at))
      : element("small", "lifecycle-derived", "Sequence only · time not recorded");
    row.append(step, copy, when);
    return row;
  });
  document.querySelector("#lifecycle-list").replaceChildren(...(rows.length === 0
    ? [element("p", "empty-state", "No deploys are recorded for this environment.")]
    : rows));
}

// Stratum 3 — hits/rejects. The existing request receipts, scoped to the active
// environment and optionally filtered by decision via the chips.
function renderRequestFeed() {
  for (const chip of document.querySelectorAll("[data-activity-filter]")) {
    chip.classList.toggle("is-active", chip.dataset.activityFilter === activityDecisionFilter);
  }
  const events = selectedAngel().activity
    .filter((event) => event.environment === activeEnvironment)
    .filter((event) => activityDecisionFilter === "all" || event.decision === activityDecisionFilter);
  if (!events.some((event) => event.requestId === selectedActivityId)) selectedActivityId = events[0]?.requestId;
  const rows = events.map((event) => {
    const row = element("button", `activity-row${event.requestId === selectedActivityId ? " is-active" : ""}`);
    row.type = "button";
    row.dataset.activityId = event.requestId;
    const copy = element("span");
    copy.append(element("code", "", event.tool), element("small", "", `${event.requestId} · ${event.detail}`));
    row.append(copy, element("span", `decision ${decisionClass(event.decision)}`, event.decision));
    return row;
  });
  const host = document.querySelector("#activity-list");
  host.replaceChildren(...(rows.length === 0
    ? [element("p", "empty-state", "No requests match this filter in this environment.")]
    : rows));
  renderActivityDetail(events.find((event) => event.requestId === selectedActivityId));
}

function renderActivity() {
  paintEnvironmentBadge(document.querySelector("#lifecycle-environment"));
  paintEnvironmentBadge(document.querySelector("#activity-environment"));
  renderDecisionCard();
  renderLifecycle();
  renderRequestFeed();
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function render() {
  resetKeysPaneTransient();
  renderHome();
  const angelNavigation = document.querySelector('.nav-item[data-route="angel"]');
  angelNavigation.disabled = demoState.angels.length === 0;
  if (demoState.angels.length === 0) {
    activeRoute = "home";
    document.querySelector("#angel-rail-list").replaceChildren();
    applyNavigation();
    setActionControls(document.querySelector("#app").getAttribute("aria-busy") === "true");
    return;
  }
  if (!demoState.angels.some((angel) => angel.id === activeAngelId)) {
    activeAngelId = demoState.angels[0]?.id;
  }
  renderAngelHeading();
  renderEnvironmentSeam();
  renderPermissions();
  renderKeys();
  renderActivity();
  renderSettings();
  applyNavigation();
  setActionControls(document.querySelector("#app").getAttribute("aria-busy") === "true");
}

function applyNavigation() {
  const screen = activeRoute;
  for (const node of document.querySelectorAll("[data-screen]")) node.hidden = node.dataset.screen !== screen;
  for (const node of document.querySelectorAll("[data-route]")) {
    if (node.classList.contains("nav-item")) node.classList.toggle("is-active", node.dataset.route === screen);
  }
  for (const tab of document.querySelectorAll("[data-pane]")) tab.classList.toggle("is-active", tab.dataset.pane === activePane);
  for (const pane of document.querySelectorAll("[data-pane-section]")) {
    pane.hidden = pane.dataset.paneSection !== activePane;
    pane.classList.toggle("is-active", pane.dataset.paneSection === activePane);
  }
}

function navigate(route) {
  resetKeysPaneTransient();
  if (route === "home") {
    activeRoute = "home";
  } else if (route === "connections") {
    activeRoute = "connections";
  } else {
    if (demoState?.angels.length === 0) return;
    activeRoute = "angel";
    if (["permissions", "keys", "activity", "settings"].includes(route)) activePane = route;
  }
  applyNavigation();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderBlockingError(message) {
  document.querySelector("#app").hidden = true;
  document.querySelector("#blocking-error-message").textContent = message;
  document.querySelector("#blocking-error").hidden = false;
}

function clearBlockingError() {
  document.querySelector("#blocking-error").hidden = true;
  document.querySelector("#app").hidden = false;
}

function setBusy(busy) {
  document.querySelector("#app").setAttribute("aria-busy", String(busy));
  setActionControls(busy);
}

function setActionControls(busy) {
  const angel = demoState?.angels.find((candidate) => candidate.id === activeAngelId);
  const environment = angel?.environments[activeEnvironment];
  const gateDrifted = environment !== undefined
    && (environment.gateAlignment.installation !== "aligned"
      || environment.gateAlignment.availability !== "aligned");
  for (const control of document.querySelectorAll("[data-action]")) {
    const normalAvailabilityAction = control.dataset.availabilityAction !== undefined;
    const availabilityBlocked = normalAvailabilityAction
      && (environment === undefined
        || environment.deploymentId === null
        || environment.pendingAvailabilityRepair !== null
        || gateDrifted);
    control.disabled = busy || availabilityBlocked;
    if (availabilityBlocked) {
      if (environment === undefined) {
        control.title = "Demo state is unavailable.";
      } else if (environment.deploymentId === null) {
        control.title = "Deploy a Version before changing availability.";
      } else if (environment.pendingAvailabilityRepair !== null) {
        control.title = "Retry the pending repair before another availability change.";
      } else {
        control.title = "Gate state must converge before changing availability.";
      }
    } else {
      control.removeAttribute("title");
    }
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

async function performAction(action, tool, connectionId) {
  setBusy(true);
  try {
    demoState = await runAction(
      action,
      action === "promote" ? "production" : activeEnvironment,
      tool,
      connectionId,
    );
    clearBlockingError();
    render();
    showToast(action === "promote" ? "Exact staged Version promoted to production." : `${capitalize(activeEnvironment)} availability updated.`);
  } catch (error) {
    renderBlockingError(errorMessage(error));
  } finally {
    setBusy(false);
  }
}

document.addEventListener("click", (event) => {
  // Prototype expand/collapse for provider:account cards, tool groups, and guarded
  // tools. Skip clicks that land on an availability toggle (a [data-action] control
  // lives inside .tg-head), so flipping a toggle never merely expands the guard.
  if (!event.target.closest("[data-action]")) {
    const guardHead = event.target.closest(".tg-head");
    if (guardHead) { guardHead.closest(".tool-g").classList.toggle("open"); return; }
    const groupHead = event.target.closest(".mgrp-head");
    if (groupHead) { groupHead.parentNode.classList.toggle("open"); return; }
    const providerHead = event.target.closest(".mprov-head");
    if (providerHead) { providerHead.parentNode.classList.toggle("open"); return; }
  }

  const connectionAction = event.target.closest("[data-connection-action]");
  if (connectionAction) void runConnectionAction(connectionAction);

  const keyActionControl = event.target.closest("[data-key-action]");
  if (keyActionControl) {
    handleKeyAction(keyActionControl.dataset.keyAction, keyActionControl.dataset.keyId);
    return;
  }

  const density = event.target.closest("[data-density]");
  if (density) {
    homeDensity = density.dataset.density;
    renderHome();
  }

  const angelTarget = event.target.closest("[data-angel-id]");
  if (angelTarget) {
    activeAngelId = angelTarget.dataset.angelId;
    selectedActivityId = undefined;
    render();
  }

  const route = event.target.closest("[data-route]");
  if (route) navigate(route.dataset.route);

  const pane = event.target.closest("[data-pane]");
  if (pane) {
    activePane = pane.dataset.pane;
    resetKeysPaneTransient();
    renderKeys();
    applyNavigation();
  }

  const environment = event.target.closest("[data-environment]");
  if (environment) {
    activeEnvironment = environment.dataset.environment;
    resetKeysPaneTransient();
    // The header logos + charter are per-environment, so re-render the heading
    // together with the version/sha seam line — otherwise production could keep
    // showing a provider only preview deploys.
    renderAngelHeading();
    renderEnvironmentSeam();
    renderPermissions();
    renderKeys();
    renderActivity();
    renderSettings();
    setActionControls(document.querySelector("#app").getAttribute("aria-busy") === "true");
  }

  const activityFilter = event.target.closest("[data-activity-filter]");
  if (activityFilter) {
    activityDecisionFilter = activityFilter.dataset.activityFilter;
    selectedActivityId = undefined;
    renderRequestFeed();
  }

  const activity = event.target.closest("[data-activity-id]");
  if (activity) {
    selectedActivityId = activity.dataset.activityId;
    renderRequestFeed();
  }

  const action = event.target.closest("[data-action]");
  if (action) void performAction(action.dataset.action, action.dataset.tool, action.dataset.connectionId);
});

document.querySelector("#retry-state").addEventListener("click", async () => {
  clearBlockingError();
  setBusy(true);
  try {
    demoState = await loadState();
    document.querySelector(".loading-screen").hidden = true;
    render();
  } catch (error) {
    renderBlockingError(errorMessage(error));
  } finally {
    setBusy(false);
  }
});

document.querySelector("#provider-app-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const body = {
    providerAppId: values.providerAppId,
    provider: "google",
    displayName: values.displayName,
    clientId: values.clientId,
    clientSecret: values.clientSecret,
  };
  form.reset();
  try {
    await fetchProvider("/api/provider-apps", { method: "POST", body: JSON.stringify(body) });
    await loadProviderCustody();
  } catch (error) {
    document.querySelector("#custody-status").textContent = errorMessage(error);
  }
});

document.querySelector("#connection-authorize-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await startProviderAuthorization(body.providerAppId, body.nickname);
  } catch (error) {
    document.querySelector("#custody-status").textContent = errorMessage(error);
  }
});

const THEME_STORAGE_KEY = "angelmcp-theme";

document.querySelector("#theme-toggle").addEventListener("click", () => {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const current = document.documentElement.getAttribute("data-theme") ?? (prefersDark ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  let chrome = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!chrome) {
    chrome = document.createElement("meta");
    chrome.setAttribute("name", "theme-color");
    // theme-color uses the first matching meta in tree order; place the
    // override before the OS-scoped metas so a manual choice wins.
    const scoped = document.querySelector('meta[name="theme-color"][media]');
    if (scoped) scoped.parentNode.insertBefore(chrome, scoped);
    else document.head.appendChild(chrome);
  }
  chrome.setAttribute("content", next === "dark" ? "#17150f" : "#faf9f3");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (error) { /* localStorage unavailable — theme just won't persist */ }
});

(async function start() {
  try {
    demoState = await loadState();
    document.querySelector(".loading-screen").hidden = true;
    document.querySelector("#app").setAttribute("aria-busy", "false");
    render();
    await loadProviderCustody();
  } catch (error) {
    renderBlockingError(errorMessage(error));
  }
})();
