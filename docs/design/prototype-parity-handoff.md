# Prototype parity handoff

Audience: the designer maintaining the AngelMCP control mockup.

The shipped control UI was recomposed to the prototype's visual idiom, but the
build and the mockup have drifted apart in specific, deliberate ways. This
document lists every place they differ so the mockup can be updated to be
apples-to-apples with the real product. Nothing here is a bug report — each
divergence is a decision the product made because of what the backend can
actually back.

Reference prototype: https://files.samcollins.blog/angel-prototype.html

## 1. Where the build intentionally diverges from the prototype

### Per-key Copy is gone; Copy lives only on the one-time reveal
Keys are hashed at rest, so the product can never re-display a key it already
issued. The Agent Keys pane shows each key by name plus a fingerprint only, with
**Rotate** and **Revoke** — no per-row Copy. A full plaintext key appears exactly
once, in an amber reveal card at mint or rotate ("Save it now — it will not be
shown again"), and Copy exists only there. The prototype's key rows
(`key_live_••••3f2` with a Copy button on every row) assume retrievable keys,
which the product does not have.
*Ask: add the one-time reveal state to the mockup and remove per-row Copy from
the resting key list.*

### Fingerprints are real hash prefixes, not `key_live_…` shapes
Each key is identified by a 12-hex public hash prefix, rendered as `••••` plus
its last three characters (e.g. `••••415`, `••••cbc`). There is no `key_live_…`
vanity shape anywhere in the resting UI. The one-time reveal is the only place a
full token string (`ak_production_…`) is shown.
*Ask: switch the mockup's key identifiers to `••••`+last-3 fingerprints.*

### No "+ New angel" rail row
The prototype's Angels rail ends with a blue "+ New angel" row. The product omits
it: creating an Angel is a CLI journey, surfaced by the zero-Angel Home guide, and
an in-app "New angel" row would be a dead end (there is no in-app creation route,
and the IA contract bans the surface). The rail lists existing Angels only.
*Ask: decide whether the mockup should show "+ New angel" at all; if kept, it
needs to be framed as a link into the CLI story, not an in-app form.*

### Dashboard activity chart omitted
The prototype's dashboard cards carry a 90-day bar chart with tool-call /
rejection / visit counts and a legend. The product omits it: no backend produces
those counts yet. It will return when the ledger lands. (The `.chart`,
`.chart-legend`, and `.s-*` bar styles remain in the CSS, marked reserved, so the
component can be revived without a redesign.)
*Ask: keep the chart in the mockup, but treat it as a future state, not shipped.*

### No fleet-wide "Pause all" on Home
The prototype's Home header has a red "Pause all" button acting on the whole
fleet. The product has no single backed action that pauses everything, so Home
has no such control. Pause/resume is per-Angel and per-environment: it lives on
the Angel's **Settings → Availability** pane ("Pause all" / "Resume all" scoped to
the active environment's tool bindings).
*Ask: move "Pause all" out of the Home header in the mockup; if shown at all, it
belongs on the per-Angel availability pane and reads as environment-scoped.*

### Group rows read "N allowed" / "N read" from real ANGEL.yaml groups
Tool groups are the real `tool.group` values from `ANGEL.yaml`. A read-only group
(group `Read`) counts as "N read"; every other group counts as "N allowed"
(e.g. "1 read", "1 allowed", "2 read"). A fully read-only provider also carries a
`READ-ONLY` badge on its provider head instead of per-tool badges. The prototype
labels every group "N allowed".
*Ask: adopt the read/allowed split and the provider-level READ-ONLY badge where
the data supports it.*

### Tab naming: Config → Allowed Tools, MCP & Keys → Agent Keys
The Angel-detail subtabs were renamed. Prototype `Config` is the product's
**Allowed Tools**; prototype `MCP & Keys` is the product's **Agent Keys**.
`Activity` and `Settings` are unchanged.
*Ask: rename the two tabs in the mockup to match.*

## 2. Wedge inventory

A "wedge" is a small dashed amber block (`.wedge` + a plain-language
"not in the design yet" tag) marking real product detail the approved mockup
does not yet have a home for. Its `title` tooltip carries the full context —
what the data is, why it is parked, and a pointer back to this document — so a
person or agent inspecting the live UI can self-serve the story. It reads as
"designer, please place this," not as an error. There is exactly **one** live wedge in the product today:

- **Home dashboard card — per-environment version line.** On each Home dashboard
  card (the `.dcard` "Dashboard" density), below the tool groups, a wedge carries
  the per-environment Version story: `prod version N · staging version N`, and,
  when a promotion is staged, `· Version N ready for exact promotion`.
  - *What the data is:* the real deployed Version number per environment, plus the
    product's exact-promotion readiness hint. Both come straight from demo state
    (`environment.version`, `angel.readyForProduction`); nothing is fabricated.
  - *Why it must stay visible:* the version-per-environment relationship is the
    backbone of the product's exact-promotion model — the operator needs to see,
    at a glance from Home, what is running where and whether a promotion is ready.
    The prototype card has no equivalent line (it spends that space on the
    activity chart, which the product omitted).
  - *Ask: give this a designed home on the dashboard card so it can shed the
    wedge treatment.*

## 3. Back-office relocations

These exist in the product even though the prototype never showed them. The
designer should know they exist; they do not need mockup surfaces unless we
decide to promote them.

- **Per-version sha / digest → Settings → Version history.** Each published Version
  shows its full immutable `sha256:…` digest in the Version history card on the
  Angel's Settings pane. The front door no longer shows a digest — Versions are
  immutable, history-only (no rename, remove, or export).
- **Gate alignment · bindings-available · availability revision → Settings →
  Availability.** The mechanical availability detail — gate alignment (Exact /
  mismatched), bindings available (N / N), and the availability revision number —
  lives in the Availability card on Settings, not on the front door.
- **Degraded availability stays loud on the front door — by design.** The one piece
  of availability state that is *not* relocated: when an environment is degraded
  (frozen, gate drift, or a pending repair), the loud warn/danger banner stays on
  the Angel's front door. Healthy states are quiet; degraded states are meant to
  be impossible to miss.

## 4. Known cosmetic deltas worth a designer pass

Honest visual differences found comparing the current screens to the prototype.
None change behavior; all are candidates for a mockup pass.

- **Home hero headline dropped.** The prototype opens Home with a large hero
  ("4 angels. All healthy.") above the cards. The product uses a smaller
  eyebrow + `h1` ("PERSONAL / Home") and a one-line reassure row
  ("✓ 3 Angels · all healthy") instead — no oversized hero. Decide which
  treatment is canonical.
- **Identity chip vs avatar.** The prototype's top-right is a round avatar
  ("S"). The product shows a static two-line identity/context cluster
  ("Personal / ACCESS PROTECTED") plus a light/dark theme toggle, and no
  avatar; the Connections screen adds its own separate "Owner view" pill.
- **Primary nav bar.** The product has a real top-level nav (Home · Angels ·
  Connections) that the single-page prototype lacks (the prototype's bottom
  "PROTOTYPE" strip is scaffolding, not product chrome).
- **Angel header is denser.** The product's Angel header adds a charter
  description line and a `Production · Version N` line under the name, plus a
  Staging/Production environment segmented control on the right. The prototype
  header is just name · tool count · Pause · Live pill.
- **Dashboard cards show group summaries, not per-tool toggles.** In the Dashboard
  density the product card lists group rows with count chips (Read · "1 tool");
  the prototype card lists individual tools with inline toggles. The per-tool
  toggles live on the Allowed Tools pane in the product.
- **Connections is a product-specific screen.** The Account → Connections custody
  screen (Provider App + Connection forms, provider/connection lists with scope
  chips and per-row health) has no prototype counterpart; it renders from real
  custody state. No parity work is expected here — flagged so the mockup does not
  try to invent one.
