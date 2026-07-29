# Google read proof: operator lifecycle

This is the setup and lifecycle exercise for the real `google-read-proof`
deployment. It is separate from the scheduled acceptance workflow. The
scheduled runner receives only `GOLDEN_GATEWAY_URL`, `GOLDEN_ANGEL_KEY`,
`GOLDEN_GMAIL_QUERY`, and `GOLDEN_DOC_ID`; it does not receive Cloudflare
Access, management, Google, or OAuth credentials.

Steps marked **Sam in a browser** require the operator to use the Cloudflare
Access-protected control site or Google Cloud/Google consent screens.

## Verified outcome — 2026-07-22

Broker, Gateway, and Control are deployed from the Milestone 1 branch, including
the live Control, OAuth, and provider-error corrections exercised below.
Unauthenticated Control root requests redirect to Access (`302`), the Access
service-token path reaches the app (`200`), and live reset/state reads pass.

Provider App `google-primary` is stored write-only and its safe summary reads.
Cloudflare account login and Google consent created a healthy Connection.
`google-read-proof` was published and deployed; seeded Gmail and Docs calls
passed. Revocation made the runner fail loudly. Row-level **Reauthorize**
preserved the same Connection identity, and both calls passed again.

The runner passed locally with live secrets, and its GitHub Actions schedule
and `workflow_dispatch` became runnable when the M1 merge put the workflow
file on the default branch. The OAuth app is in External Testing, so the
refresh token expires after seven days; do not claim durable scheduled
monitoring yet.

1. **Sam in a browser — Access login.** Open the control/www URL and complete
   **Cloudflare account login** for the M1 Account. The configured interactive
   identity provider is not one-time PIN. Keep the browser session open for the
   custody screens and provider callback.
2. **Sam in a browser — verify the BYO Google client.** Provider App
   `google-primary` is already stored. Confirm its safe summary on the
   Connections page's Google custody panel; the client secret must not be
   readable. If rebuilding the setup, use
   the OAuth client with the deployed callback URI and required read-only Gmail
   and Docs APIs. Never put its secret in this repository or the acceptance
   workflow.
3. **Sam in a browser — consent and Connection.** Start a Google authorization
   for that Provider App, complete the fixed read-only consent screen, and
   create the Connection with the nickname used by the local deployment config.
   Confirm the selected Connection is healthy. Do not copy or expose an
   internal Connection ID; revoke and reauthorize are actions on this selected
   Connection in the UI. Verify continuity later from the management/API
   response or the UI's selected-Connection state.
4. **Local operator shell.** Copy the safe example and edit only local
   deployment concerns:

   ```sh
   cp angels/google-read-proof/angel.example.json angels/google-read-proof/angel.json
   ```

   Set the real control target, Account, Angel slug, and the same healthy
   Connection nickname under both `docs` and `gmail` in the `staging` map (the
   pinned CLI's spelling of the preview environment) and the `production` map.
   The real `angel.json` is ignored. `ANGEL.yaml` remains portable and
   target-neutral.
5. **Local operator shell — publish preview.** With the operator's management
   bearer and mandatory Access service token for the Access-protected M1
   Control endpoint, run:

   ```sh
   ANGEL_MANAGEMENT_TOKEN=... ANGEL_ACCESS_TOKEN='{"cf-access-client-id":"...","cf-access-client-secret":"..."}' bun run angel publish google-read-proof
   ```

   This builds the checked-in policy, publishes its immutable artifact, and
   installs the exact bindings in the preview environment. Verify the tool
   list contains only
   `gmail.users.messages.list` and `docs.documents.get`.
6. **Local operator shell — deploy production.** With both the management
   bearer and mandatory `ANGEL_ACCESS_TOKEN`, promote the exact staged
   deployment:

   ```sh
   ANGEL_MANAGEMENT_TOKEN=... ANGEL_ACCESS_TOKEN='{"cf-access-client-id":"...","cf-access-client-secret":"..."}' bun run angel deploy google-read-proof --prod
   ```

   The command does not rebuild or republish.
7. **Local operator shell — capture the shown-once key.** Save the production
   Angel key printed by the initial `publish`/ensure response in the GitHub
   Actions secret `GOLDEN_ANGEL_KEY`. Do not paste it into a file, command
   transcript, issue, report, or chat. Set repository variables:

   - `GOLDEN_GATEWAY_URL`: the exact full production MCP endpoint — the
     canonical coordinate `https://gateway.example/@<handle>/google-read-proof`
     (the legacy `/v1/a/<account>/google-read-proof/production/mcp` shape
     still answers); do not provide only the origin, add a query, or add a
     trailing slash.
   - `GOLDEN_GMAIL_QUERY`: a unique query that is known to match at least one
     message in the custodied mailbox.
   - `GOLDEN_DOC_ID`: the pinned document ID.

   The endpoint path is supplied as one value to the runner. The runner
   validates its HTTPS and production MCP shape, then calls that exact URL; it
   does not hard-code or reconstruct Account or Angel identity.
8. **Local operator shell — run the real acceptance.** Run the local runner,
   or — now that the workflow is on the default branch — its schedule and
   `workflow_dispatch` can run the same acceptance. Both operations must pass
   through Gateway and Broker. Do not copy provider identity, fixture values,
   secrets, or request IDs into documentation or reports.
9. **Sam in a browser — revoke and prove failure.** On the Connections page,
   revoke the same Connection. Run the acceptance again and confirm it fails
   loudly with a non-success result; do not treat a skipped call or a malformed
   input as proof. The failure must occur after the request reaches the deployed
   path and the revoked custody can no longer authorize Google.
10. **Sam in a browser — reauthorize the selected Connection.** Use
    **Reauthorize** on the selected Connection, complete Google consent again,
    and confirm through the management/API response or UI continuity that it is
    the same Connection and health returns to healthy. Run the acceptance once
    more; both operations must pass again.

Never give the scheduled runner a Google password, refresh token, OAuth client
secret, Cloudflare Access credential, management token, or Cloudflare control
credential. The Broker owns provider custody; CI owns only the opaque Angel key
needed for the public production MCP endpoint.

Steps 1–10 passed in order on 2026-07-22. Any later screenshot or video must
remain privacy-safe: do not expose provider identity, document/query fixtures,
credentials, Angel keys, Connection identifiers, or request IDs.
