// Read-only backend for the public demo page.
//
// The page is the real dashboard: docs-site/build.sh copies www/index.html,
// app.js and app.css verbatim, so what a visitor clicks is byte-for-byte what
// an Account owner sees. There is no server behind it. This script installs a
// fetch that answers the dashboard's read calls out of a generated fixture and
// refuses everything else, so a visitor can look but not act.
//
// It must run before app.js. index.html loads app.js with `defer`, and this
// file is injected as a plain (non-deferred) script above it, so patching
// window.fetch here always wins the race.
//
// The READS map below is asserted against the fetch call sites in www/app.js by
// tests/cloud/public-demo.test.ts, which also executes this file against a stub
// DOM. Adding a read path to the dashboard without adding it here fails CI
// rather than silently breaking the demo.
(function () {
  "use strict";

  var originalFetch = window.fetch.bind(window);

  var READS = {
    "/api/demo/state": "state",
    "/api/provider-apps": "apps",
    "/api/connections": "connections",
  };

  // No trailing full stop: app.js interpolates this into its own sentence and
  // adds one ("Provider custody unavailable: <error>.").
  var REFUSAL = "this is a read-only demo of Angel Cloud on sample data, so "
    + "changes are turned off — nothing here connects to a real account";

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

  function refused() {
    return Promise.resolve(json({ error: REFUSAL }, 403));
  }

  // A Request or a URL is as legal an argument as a string, and both used to
  // throw here. Resolve all three to one absolute URL before deciding anything.
  function target(input) {
    if (typeof input === "string" || input instanceof URL) {
      return new URL(String(input), location.href);
    }
    if (input && typeof input.url === "string") return new URL(input.url, location.href);
    return null;
  }

  // Allowlist, not denylist, and nothing at all reaches the network. An earlier
  // version forwarded anything whose URL lacked "/api/", which let an absolute
  // cross-origin URL — including the product's own /v1/ management surface —
  // out from a public page; forwarding same-origin GETs still left a
  // redirect-to-cross-origin path and treated blob: URLs as same-origin. The
  // fixture is read through originalFetch before this replacement is installed,
  // and app.js fetches nothing but /api/ paths, so once installed every request
  // is either one of the three mapped reads or refused.
  window.fetch = function (input, options) {
    var url = target(input);
    if (url === null || url.origin !== location.origin) return refused();

    var method = ((options && options.method)
      || (input && typeof input !== "string" && input.method)
      || "GET").toUpperCase();
    if (method !== "GET") return refused();

    var key = READS[url.pathname];
    if (key === undefined) return refused();
    return fixture.then(function (data) { return json(data[key]); });
  };

  // The Connections tab renders credential-entry fields, including a Google
  // client secret. The shim refuses the POST, so a typed value goes nowhere —
  // but a public page must not invite anyone to type a secret into it at all,
  // and a merely unfillable field still enters FormData if a password manager
  // or a script writes to it.
  //
  // The two custody forms are static markup in www/index.html, so `disabled` on
  // their fields holds: renderProviderCustody only repaints the two lists and
  // the selector's options. `disabled` also drops them from FormData and from
  // the tab order, which pointer-events alone does not. Their `required`
  // attributes come off too — otherwise constraint validation swallows the
  // submit event and the two primary buttons dead-end on a native "please fill
  // out this field" bubble instead of reaching the app and showing the refusal.
  //
  // The stylesheet and the capture-phase blockers stay as a blanket for inputs
  // the app creates later, which per-element attributes would not survive.
  var STATIC_FORMS = ["#provider-app-form", "#connection-authorize-form"];

  function seal() {
    var style = document.createElement("style");
    style.textContent = "input,textarea,select{pointer-events:none!important;"
      + "opacity:.55;cursor:not-allowed}";
    document.head.appendChild(style);

    STATIC_FORMS.forEach(function (selector) {
      var form = document.querySelector(selector);
      if (form === null) return;
      var fields = form.querySelectorAll("input,textarea,select");
      for (var i = 0; i < fields.length; i += 1) {
        fields[i].removeAttribute("required");
        fields[i].disabled = true;
        // renderProviderCustody sets provider-app-selector.disabled = false on
        // every repaint, which would un-seal it and put it back in FormData.
        // Pin the property so the app's assignment is a no-op.
        Object.defineProperty(fields[i], "disabled", {
          configurable: true,
          get: function () { return true; },
          set: function () {},
        });
      }
    });

    document.addEventListener("beforeinput", function (event) { event.preventDefault(); }, true);
    document.addEventListener("paste", function (event) { event.preventDefault(); }, true);

    // A 403 is the right answer and the wrong experience. performAction routes a
    // failed mutation to renderBlockingError, which hides #app — so a visitor's
    // first click on an availability toggle or Promote replaced the whole demo
    // with an error page. The key surface dead-ended differently: its name field
    // is created by the app, so the blockers above make it unfillable and
    // "Create" never got past "Enter a key name."
    //
    // Both are answered here rather than in www/app.js, which stays unforked.
    // This listener is on document in the capture phase, so it runs before the
    // app's own document-level click handler. Disabling the controls instead
    // would not hold: setActionControls reassigns `disabled` on every render.
    document.addEventListener("click", function (event) {
      var control = event.target.closest && event.target.closest("[data-action],[data-key-action]");
      if (control === null || control === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      var toast = document.getElementById("toast");
      if (toast === null) return;
      toast.textContent = "Read-only demo — " + REFUSAL;
      toast.hidden = false;
      clearTimeout(toast.dataset.demoTimer);
      toast.dataset.demoTimer = setTimeout(function () { toast.hidden = true; }, 4000);
    }, true);
  }

  // Say what this is, in the page. Without it the shell reads as a real signed-in
  // Account — it even carries the dashboard's own "Signed in" label, which is
  // true of the product and false of this page. The banner is added to the DOM
  // rather than written into the shell so www/index.html stays unforked.
  //
  // It scrolls away rather than sticking: app.css pins .topbar at top:0, and a
  // second sticky element at the same offset overlaps the nav instead of
  // stacking above it.
  function banner() {
    var bar = document.createElement("div");
    bar.setAttribute("role", "note");
    bar.style.cssText = "position:relative;z-index:9999;padding:10px 16px;"
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
