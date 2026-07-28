# PD 0003: Publishing goes live; preview is opt-in and shares credentials

- Status: Agreed
- Date: 2026-07-28
- Implemented: No
- Tracked: none yet

## Decision

Three changes to the publishing model:

1. **`angel publish` deploys to production.** One command takes an Angel from
   source to live. The second environment is no longer on the default path.
2. **The second environment is called `preview`**, not `staging`. It is
   reached by asking for it — `angel publish --preview`, then a promote step
   for the exact previewed Version.
3. **Preview binds the same Connections as production by default.** Choosing
   different credentials per environment stays possible and stays explicit.

The suffix in [PD 0001](0001-angel-coordinate-scheme.md) becomes `@preview`.
Bare still means production.

## Why

The two-step protects an Angel that is already in use. On a first publish
there is nothing to protect, so the cost lands entirely on the person least
able to pay it — someone meeting the idea of environments for the first time,
before they have anything running.

"Staging" is operator language. It names a release process a single person
does not have. "Preview" says what the thing is for and matches what people
already know from Vercel and Netlify.

The credential default follows practice rather than fighting it. The only
real `angel.json` in existence names the same Connection for staging and
production. The separate-bindings rule was being satisfied by typing the same
answer twice, which is a rule that teaches nothing and catches nothing.

## What this does not change

`angel deploy --prod` still promotes the **exact bytes** of a previewed
Version. It does not rebuild, republish, or select a different Version. The
digest-pinned promotion in [ADR 0003](../adrs/0003-immutable-version-promotion.md)
is the part that earned its keep, and it survives untouched.

Preview keeps its own gate, availability overlay, endpoint, and agent keys.
Only the credential *default* moves.

## Where this overrides ADR 0003

ADR 0003 rejected "copy staging bindings automatically: violates environment
isolation". Point 3 above chooses close to what that rejected — deliberately,
and as a product call overriding an architecture preference.

ADR 0003 also said to revisit "after exact promotion is proven in use". It has
been: promotion ran live during M1, and what it showed is that binding
isolation was never exercised, while the ceremony was paid every time.

## The hazard this creates

**A preview run touches real data.** Once preview shares production
Connections by default, "preview" stops meaning "safe sandbox" — a previewed
Angel reads the same mailbox and writes the same documents as the live one.
Anyone reading the word will assume otherwise.

This must be visible where it matters: at the moment a preview deployment is
created, and on the preview surface itself, not only in this record. An Angel
whose tools write should make the shared-credential state impossible to miss.

Separate Connections per environment remain the answer for anyone who wants a
true sandbox, and the platform must keep making that easy.

## What runs instead today

`angel publish` deploys to staging and nothing else. Production requires
`angel deploy --prod`. There is no way to publish an Angel live in one step,
and the word "staging" appears in the CLI, the route grammar, and the docs.

## Open

- Whether promotion from preview needs a confirmation step once bindings are
  shared by default, since the binding review that used to serve as one is
  gone.
- The exact CLI spelling. `angel publish --preview` is indicative, not
  settled; it lands with the implementation.
