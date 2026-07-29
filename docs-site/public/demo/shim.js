// Read-only backend for the public demo page.
//
// The page is the real dashboard: docs-site/build.sh copies www/index.html,
// app.js and app.css verbatim, so what a visitor clicks is byte-for-byte what
// an Account owner sees. There is no server behind it. This script installs a
// fetch that answers the dashboard's three read calls out of a generated
// fixture and refuses everything else, so a visitor can look but not act.
//
// It must run before app.js. index.html loads app.js with `defer`, and this
// file is injected as a plain (non-deferred) script above it, so patching
// window.fetch here always wins the race.
//
// PUBLIC_DEMO_READ_PATHS below is asserted against the fetch call sites in
// www/app.js by tests/cloud/public-demo.test.ts. Adding a read path to the
// dashboard without adding it here fails CI rather than silently breaking the
// demo.
(function () {
  "use strict";

  var originalFetch = window.fetch.bind(window);

  var READS = {
    "/api/demo/state": "state",
    "/api/provider-apps": "apps",
    "/api/connections": "connections",
  };

  var fixture = originalFetch("fixture.json").then(function (response) {
    if (!response.ok) throw new Error("demo fixture unavailable: HTTP " + response.status);
    return response.json();
  });

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { "content-type": "application/json" },
    });
  }

  window.fetch = function (input, options) {
    var path = typeof input === "string" ? input : input.url;
    var method = ((options && options.method) || (input && input.method) || "GET").toUpperCase();

    // Let the fixture itself, and anything else same-origin and static, through.
    if (path.indexOf("/api/") === -1) {
      return originalFetch(input, options);
    }
    var key = method === "GET" ? READS[new URL(path, location.href).pathname] : undefined;
    if (key !== undefined) {
      return fixture.then(function (data) { return json(data[key]); });
    }
    return Promise.resolve(json({
      error: "This is a read-only demo of Angel Cloud on sample data. "
        + "Nothing here connects to a real account, so changes are turned off.",
    }, 403));
  };

  // Say what this is, in the page. Without it the shell reads as a real signed-in
  // Account — it even carries the dashboard's own "ACCESS PROTECTED" label, which
  // is true of the product and false of this page. The banner is added to the DOM
  // rather than written into the shell so www/index.html stays unforked.
  // The dashboard's Connections tab renders credential-entry fields, including a
  // Google client secret. The shim already refuses the POST, so a typed value
  // goes nowhere — but a public page must not invite anyone to type a secret
  // into it at all. Styling and a capture-phase input blocker are used instead of
  // a `disabled` sweep because the app re-renders these fields on every state
  // change and would undo per-element attributes.
  function seal() {
    var style = document.createElement("style");
    style.textContent = "input,textarea,select{pointer-events:none!important;"
      + "opacity:.55;cursor:not-allowed}";
    document.head.appendChild(style);
    document.addEventListener("beforeinput", function (event) { event.preventDefault(); }, true);
    document.addEventListener("paste", function (event) { event.preventDefault(); }, true);
  }

  function banner() {
    var bar = document.createElement("div");
    bar.setAttribute("role", "note");
    bar.style.cssText = "position:sticky;top:0;z-index:9999;padding:10px 16px;"
      + "background:#1c1917;color:#fafaf9;font:500 13px/1.5 ui-sans-serif,system-ui,sans-serif;"
      + "text-align:center;box-shadow:0 1px 0 rgba(0,0,0,.2)";
    bar.textContent = "Demo — the real Angel Cloud dashboard, filled with sample data. "
      + "This is not anyone's account, and every change is turned off.";
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function start() { seal(); banner(); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
