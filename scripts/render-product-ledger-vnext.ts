import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const escapeHtml = (value: unknown) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const cls = (value: string) => value.toLowerCase().replaceAll(" ", "-");
const pill = (kind: string, value: string) => `<span class="pill ${kind}-${cls(value)}">${escapeHtml(kind)}: ${escapeHtml(value)}</span>`;
const link = (value: any) => `<a href="${escapeHtml(value.href)}" target="_blank" rel="noreferrer">${escapeHtml(value.label)}</a>`;
const field = (label: string, value: string) => `<div class="field"><strong>${escapeHtml(label)}</strong><div>${value}</div></div>`;
function requireValue(condition: unknown, message: string): asserts condition {
 if (!condition) throw new Error(`invalid Angel vNext dataroom: ${message}`);
}

export function validateProductLedgerVnext(data: any): void {
 requireValue(data && typeof data === "object", "root must be an object");
 requireValue(data.$schema === "product-ledger/proposed-v0.2-roadmap-bridge", "schema must name the proposed v0.2 bridge");
 requireValue(data.contract?.status === "PROPOSED" && data.contract?.approved === false, "contract must remain proposed and unapproved");
 requireValue(Array.isArray(data.truthCorrections) && data.truthCorrections.length > 0, "truth corrections are required");
 requireValue(typeof data.canonicalSource?.html === "string" && data.canonicalSource.html.length > 0, "lossless approved v0.1 snapshot is required");
 requireValue(createHash("sha256").update(data.canonicalSource.html).digest("hex") === data.canonicalSource.sha256, "approved v0.1 snapshot hash must match");
 requireValue(Array.isArray(data.canonicalSource.sectionIds) && data.canonicalSource.sectionIds.length > 0, "approved v0.1 section inventory is required");
 const sectionIds = [...data.canonicalSource.html.matchAll(/<section id="([^"]+)"/g)].map((match: RegExpMatchArray) => match[1]);
 requireValue(JSON.stringify(sectionIds) === JSON.stringify(data.canonicalSource.sectionIds), "approved v0.1 section inventory must match its snapshot");
 requireValue(data.canonicalSource.controlInventory && typeof data.canonicalSource.controlInventory === "object", "approved v0.1 control inventory is required");
 for (const [attr, keys] of Object.entries(data.canonicalSource.controlInventory)) {
  requireValue(Array.isArray(keys), `${attr} control inventory must be an array`);
  const actual = [...data.canonicalSource.html.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))].map((match: RegExpMatchArray) => match[1]);
  requireValue(JSON.stringify(actual) === JSON.stringify(keys), `${attr} control inventory must match its snapshot`);
 }
 requireValue(Array.isArray(data.roadmap) && data.roadmap.length > 0, "roadmap is required");
 const keys = new Set<string>();
 for (const epic of data.roadmap) {
  requireValue(typeof epic.key === "string" && !keys.has(epic.key), `Epic key must be unique: ${epic.key}`);
  keys.add(epic.key);
  requireValue(epic.role === "Epic" && typeof epic.title === "string" && typeof epic.outcome === "string", `${epic.key} must be a named owner-outcome Epic`);
  requireValue(typeof epic.truth === "string" && typeof epic.plan === "string" && typeof epic.approval === "string", `${epic.key} needs separate truth, plan, and approval states`);
  requireValue(Array.isArray(epic.mapsTo) && epic.mapsTo.length > 0, `${epic.key} needs canonical mappings`);
  requireValue(epic.gate?.key === `GATE-${epic.key}` && typeof epic.gate?.proof === "string", `${epic.key} needs its exact owner gate`);
  requireValue(epic.gate?.evidence?.href, `${epic.key} gate needs evidence`);
  requireValue(Array.isArray(epic.commitments) && Array.isArray(epic.work), `${epic.key} needs commitment and work arrays`);
  for (const work of epic.work) {
   requireValue(work.kind === "Feature" || work.kind === "Task", `${work.key} must be a Feature or Task`);
   requireValue(typeof work.proof === "string" && work.proof.includes(work.kind === "Feature" ? "Feature dogfood" : "Task smoke"), `${work.key} needs the right proof type`);
   requireValue(Array.isArray(work.mapsTo) && work.mapsTo.length > 0 && work.evidence?.href, `${work.key} needs mappings and evidence`);
  }
 }
 requireValue(data.roadmap.filter((epic: any) => epic.plan === "ACTIVE").length === 1, "exactly one Epic must be active");
}

const styles = `<style id="vnext-roadmap-styles">
.vnext-boundary{margin:0 0 24px;padding:14px 16px;background:#fff1cf;box-shadow:inset 4px 0 0 #e5007a;border-radius:0 9px 9px 0}.vnext-boundary b{color:#9c175e}.vnext-corrections-block{margin:14px 0 20px;background:#fff;border:1px solid var(--line)}.vnext-corrections-block>summary{padding:10px 12px;font-weight:800}.vnext-corrections{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:0 10px 10px}.vnext-correction{background:#fff;border:1px solid var(--line);padding:10px;font-size:12px}.truth-not-built{background:#eef1f5;color:#58667b}.vnext-roadmap{display:grid;gap:12px}.vnext-history{background:#fff;border:1px solid var(--line)}.vnext-history>summary{padding:11px 12px;font-weight:800}.vnext-history-list{display:grid;gap:6px;padding:0 8px 8px}.vnext-history .vnext-epic{border-radius:8px;padding:0}.vnext-history .vnext-epic>summary{padding:9px}.vnext-history .vnext-title{font-size:16px}.vnext-epic{background:#f3f4f6;border:1px solid var(--line);border-radius:14px;padding:0 10px 10px}.vnext-epic[data-plan-state="ACTIVE"]{border-left:0;border-radius:0 14px 14px 0;box-shadow:inset 4px 0 0 var(--accent)}.vnext-epic>summary{display:grid;grid-template-columns:58px minmax(0,1fr) auto;gap:9px;align-items:center;padding:14px 6px}.vnext-epic>summary::before,.vnext-commitment>summary::before,.vnext-work>summary::before,.vnext-gate>summary::before{display:none}.vnext-title{font:700 22px/1.12 Georgia,serif;color:var(--ink)}.vnext-role{font:9px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.vnext-pills{display:flex;gap:5px;flex-wrap:wrap;justify-content:end}.vnext-body{padding:0 6px 3px 64px}.vnext-outcome{color:#526178;margin-bottom:10px}.vnext-commitments{display:grid;gap:6px}.vnext-commitment,.vnext-work{background:#fff;border:1px solid var(--line);border-radius:8px}.vnext-commitment>summary,.vnext-work>summary{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:8px;align-items:center;padding:10px}.vnext-commitment h3,.vnext-work h3{font:700 16px/1.2 Georgia,serif;margin:0}.vnext-detail{display:grid;grid-template-columns:1fr 1fr;gap:0 18px;padding:0 12px 10px}.vnext-work-list{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);margin-top:8px}.vnext-work{border:0;border-radius:0}.vnext-gate{margin-top:10px;background:#202127;color:white}.vnext-gate>summary{display:grid;grid-template-columns:105px minmax(0,1fr);gap:8px;padding:12px}.vnext-gate .row-key{color:#ff9bc4}.vnext-gate p{margin:0;color:#e1e3e6}.vnext-gate a{color:#ffb4d3}.vnext-empty{font-style:italic;color:var(--muted);font-size:12px;padding:8px}.vnext-legacy-index{margin-top:18px;border:1px solid var(--line);background:#fff}.vnext-legacy-index>summary{padding:11px 12px;font-weight:800}.vnext-legacy-body{padding:0 12px 12px}.vnext-legacy-body>.label,.vnext-legacy-body>h2,.vnext-legacy-body>.section-note,.vnext-legacy-body>.index-tools{display:none}
@media (max-width: 640px){.vnext-corrections{grid-template-columns:1fr}.vnext-epic>summary{grid-template-columns:44px minmax(0,1fr)}.vnext-pills{grid-column:2;justify-content:start}.vnext-body{padding-left:4px}.vnext-commitment>summary,.vnext-work>summary{grid-template-columns:42px minmax(0,1fr)}.vnext-commitment>summary .pill,.vnext-work>summary .vnext-pills{grid-column:2;justify-content:start}.vnext-detail{grid-template-columns:1fr}.vnext-gate>summary{grid-template-columns:1fr}}
@media (prefers-reduced-motion: reduce){.vnext-epic summary,.vnext-work summary,.vnext-commitment summary{transition:none!important}}
</style>`;

function renderCommitment(item: any): string {
 return `<details class="vnext-commitment" data-truth-state="${escapeHtml(item.truth)}"><summary><span class="row-key">${escapeHtml(item.key)}</span><h3>${escapeHtml(item.title)}</h3>${pill("truth",item.truth)}</summary><div class="vnext-detail">${field("Eval",escapeHtml(item.eval))}${field("Limit",escapeHtml(item.limit))}${field("Evidence",link(item.evidence))}${field("Last verified",escapeHtml(item.verified))}</div></details>`;
}
function renderWork(item: any): string {
 return `<details class="vnext-work" data-truth-state="${escapeHtml(item.truth)}" data-plan-state="${escapeHtml(item.plan)}" data-approval-state="${escapeHtml(item.approval)}"><summary><span class="row-key">${escapeHtml(item.key)}<br><span class="vnext-role">${escapeHtml(item.kind)}</span></span><h3>${escapeHtml(item.title)}</h3><span class="vnext-pills">${pill("truth",item.truth)}${pill("plan",item.plan)}${pill("approval",item.approval)}</span></summary><div class="vnext-detail">${field("Claim or goal",escapeHtml(item.claim))}${field("Dogfood or smoke proof",escapeHtml(item.proof))}${field("Mapped canonical rows",escapeHtml(item.mapsTo.join(" · ")))}${field("Decisions or blockers",escapeHtml(item.blockers))}${field("Evidence",link(item.evidence))}${field("Last verified",escapeHtml(item.verified))}</div></details>`;
}
function renderEpic(row: any): string {
 const open = row.plan === "ACTIVE" ? " open" : "";
 const commitments = row.commitments.length ? row.commitments.map(renderCommitment).join("") : '<p class="vnext-empty">No new commitment enters in this Epic.</p>';
 const work = row.work.length ? `<div class="vnext-work-list">${row.work.map(renderWork).join("")}</div>` : "";
 const gate = `<details class="vnext-gate"><summary><span class="row-key">${escapeHtml(row.gate.key)}</span><p>${escapeHtml(row.gate.proof)} · ${link(row.gate.evidence)}</p></summary><div class="vnext-detail">${field("Acceptance",row.gate.accepted ? "Owner accepted" : "Not accepted; proposal or proof remains open")}${field("Mapped canonical rows",escapeHtml(row.mapsTo.join(" · ")))}</div></details>`;
 return `<details class="vnext-epic" data-index-key="${escapeHtml(row.key)}" data-truth-state="${escapeHtml(row.truth)}" data-plan-state="${escapeHtml(row.plan)}" data-approval-state="${escapeHtml(row.approval)}"${open}><summary><span><span class="row-key">${escapeHtml(row.key)}</span><br><span class="vnext-role">${escapeHtml(row.role)}</span></span><span class="vnext-title">${escapeHtml(row.title)}</span><span class="vnext-pills">${pill("truth",row.truth)}${pill("plan",row.plan)}${pill("approval",row.approval)}</span></summary><div class="vnext-body"><p class="vnext-outcome">${escapeHtml(row.outcome)}</p><div class="vnext-commitments">${commitments}</div>${work}${gate}</div></details>`;
}
function renderIndex(data: any, canonicalIndex: string): string {
 const corrections = data.truthCorrections.map((item: any) => `<article class="vnext-correction"><span class="row-key">${escapeHtml(item.key)}</span><p>${escapeHtml(item.text)}</p></article>`).join("");
 const completed = data.roadmap.filter((row: any) => row.plan === "COMPLETE");
 const remaining = data.roadmap.filter((row: any) => row.plan !== "COMPLETE");
 const history = `<details class="vnext-history"><summary>${completed.length} completed proofs · tap for full chronology</summary><div class="vnext-history-list">${completed.map(renderEpic).join("")}</div></details>`;
 const legacyBody = canonicalIndex.replace(/^<section[^>]*>/, "").replace(/<\/section>$/, "");
 const legacy = `<details class="vnext-legacy-index"><summary>Approved v0.1 Project Index record archive · complete evidence one tap away</summary><div class="vnext-legacy-body">${legacyBody}</div></details>`;
 return `<section id="project-index" data-project-index data-roadmap-list><div class="label">1 · Project Index · proposed vNext</div><h2>Use one owner outcome, then learn</h2><p class="section-note">Completed context stays compact. Active WS2 is recut into five owner-outcome Epics; every Feature has dogfood, every Task has smoke proof, and every Epic ends at an owner gate.</p><div class="callout"><strong>Current-truth overlay from draft PR #65.</strong> These corrections are newer than some preserved v0.1 prose and must be reconciled before any canonical migration.</div><details class="vnext-corrections-block"><summary>${data.truthCorrections.length} verified truth corrections · tap to inspect</summary><div class="vnext-corrections">${corrections}</div></details><div class="index-tools"><button type="button" data-index-action="expand">Expand all</button><button type="button" data-index-action="collapse">Collapse all</button></div><div class="vnext-roadmap">${history}${remaining.map(renderEpic).join("")}</div>${legacy}</section>`;
}

export function renderProductLedgerVnext(dataroom: any): string {
 validateProductLedgerVnext(dataroom);
 const canonical = dataroom.canonicalSource.html;
 const start = canonical.indexOf('<section id="project-index"');
 const end = canonical.indexOf("</section>", start) + "</section>".length;
 if (start < 0 || end < "</section>".length) throw new Error("canonical Project Index section not found");
 const canonicalIndex = canonical.slice(start, end);
 let output = canonical.slice(0, start) + renderIndex(dataroom, canonicalIndex) + canonical.slice(end);
 output = output.replace("<title>Angel Product Ledger — approved v0.1</title>", "<title>Angel Product Ledger — proposed vNext</title>");
 output = output.replace("</head>", `${styles}</head>`);
 output = output.replace("const indexRows=[...document.querySelectorAll('[data-index-key]')];", "const indexRows=[...document.querySelectorAll('#project-index details')];");
 output = output.replace("<main data-contract-version=", '<main data-proposal-contract-version="proposed-v0.2" data-contract-version=');
 output = output.replace("<header>", `<div class="vnext-boundary"><b>PROPOSED · UNAPPROVED</b> · Visual migration candidate dependent on <a href="https://github.com/exocognito/dotfiles/pull/318" target="_blank" rel="noreferrer">dotfiles PR #318</a>. Approved v0.1 remains canonical; this page preserves its full sections while testing the generated roadmap view.</div><header>`);
 output = output.replace(/\b(href|src)="(?![a-z][a-z0-9+.-]*:|#|\/)([^"]+)"/gi, '$1="../$2"');
 const snapshot = JSON.stringify(dataroom, null, 2).replaceAll("</script", "<\\/script");
 output = output.replace("</body>", `<script id="vnext-dataroom" type="application/json">\n${snapshot}\n</script></body>`);
 return output;
}

if (import.meta.main) {
 const root = join(import.meta.dir, "..");
 const dataroom = JSON.parse(readFileSync(join(root, "datarooms/angel-cloud-vnext.json"), "utf8"));
 const rendered = renderProductLedgerVnext(dataroom);
 const output = join(root, "docs/proposals/product-ledger-vnext.html");
 if (process.argv.includes("--check")) {
  const current = readFileSync(output, "utf8");
  if (current !== rendered) { console.error("product-ledger-vnext.html is stale"); process.exit(1); }
  console.log("product-ledger-vnext.html matches dataroom and canonical source");
 } else {
  writeFileSync(output, rendered);
  console.log(output);
 }
}
