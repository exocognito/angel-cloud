import type { HostedVersionArtifact } from "./domain";
import { appName, guardLabels } from "./tool-labels";

/**
 * The public Angel page (PD 0002). One view feeds both serializers, so the
 * HTML and JSON answers cannot diverge. This module must stay free of Gateway
 * imports: at the DNS cutover it lifts unchanged to the apex dispatcher.
 *
 * The view is built from the compiled artifact and the Version number alone —
 * never from a GateInstallation — so binding data (identity labels, Connection
 * ids) is out of reach by construction, not by filtering.
 */
export interface PublicAngelView {
  name: string;
  charter: string;
  version: number;
  policyDigest: string;
  provenance: string;
  tools: PublicToolView[];
}

export interface PublicToolView {
  name: string;
  provider: string;
  app: string;
  operation: string;
  guards: string[];
}

export function publicAngelView(artifact: HostedVersionArtifact, version: number): PublicAngelView {
  return {
    name: artifact.name,
    charter: artifact.charter,
    version,
    // The policy digest is the artifact digest (the gate pins them equal on
    // install), so the view never needs the installation to show it.
    policyDigest: artifact.digest,
    provenance: "This page describes an immutable artifact compiled from ANGEL.yaml.",
    tools: artifact.tools.map((tool) => ({
      name: tool.name,
      provider: tool.provider,
      app: appName(tool.provider),
      operation: tool.operation,
      guards: guardLabels(tool),
    })),
  };
}

export function renderPublicAngelHtml(view: PublicAngelView): string {
  const tools = view.tools.map((tool) => `
      <li>
        <p class="tool-name">${esc(tool.name)}</p>
        <p class="tool-operation">${esc(tool.app)} — ${esc(tool.operation)}</p>
        ${tool.guards.length === 0 ? "" : `<ul class="guards">${tool.guards.map((guard) => `<li>${esc(guard)}</li>`).join("")}</ul>`}
      </li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(view.name)} — Angel</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  .charter { font-size: 1.1rem; }
  h2 { font-size: 1rem; margin-top: 2rem; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
  ul.tools { list-style: none; padding: 0; }
  ul.tools > li { margin-bottom: 1rem; }
  .tool-name { font-weight: 600; margin: 0; }
  .tool-operation { margin: 0; color: #555; }
  ul.guards { margin: 0.25rem 0 0; padding-left: 1.25rem; color: #555; }
  footer { margin-top: 2.5rem; font-size: 0.85rem; color: #555; border-top: 1px solid #ddd; padding-top: 1rem; }
  code { word-break: break-all; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; }
    h2, .tool-operation, ul.guards, footer { color: #aaa; }
    footer { border-top-color: #333; }
  }
</style>
</head>
<body>
<main>
  <h1>${esc(view.name)}</h1>
  ${view.charter === "" ? "" : `<p class="charter">${esc(view.charter)}</p>`}
  <h2>Tools</h2>
  ${view.tools.length === 0 ? "<p>This Angel exposes no tools.</p>" : `<ul class="tools">${tools}
  </ul>`}
  <footer>
    <p>Version ${esc(String(view.version))} · policy digest <code>${esc(view.policyDigest)}</code></p>
    <p>${esc(view.provenance)}</p>
  </footer>
</main>
</body>
</html>
`;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
