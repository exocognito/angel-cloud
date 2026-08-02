# WS-E brief 2 — headless Linux OAuth storage

- Decision: O2
- Evidence status: complete
- Product implementation: none
- Outcome: close O2 for storage and retrieval
- Verified: 2026-08-01

## Question

How does headless Linux store and retrieve local OAuth credentials?

## Method

Created a disposable 2 GB Ubuntu 24.04 exe.dev VM and used synthetic credential bytes only. Tested stock headless state, Secret Service before and after installing D-Bus/GNOME Keyring/libsecret, explicit keyring unlock across SSH sessions and VM restart, encrypted-file retrieval through an inherited file descriptor, wrong-key and tamper failures, and environment/FD process visibility. Deleted the VM afterward.

## Verified results

- Stock exe.dev has no session bus, keyring daemon, display, runtime directory, or keyring tools.
- Secret Service works only after adding packages, starting D-Bus/keyring, and supplying an external unlock secret on each fresh session or boot.
- A mode-0600 encrypted file survives restart and can fail closed on missing/wrong key; authenticated product code must withhold all plaintext until tag verification.
- Environment variables leak to same-UID process inspection and children; an inherited FD is a narrower handoff but not a same-UID security boundary.

## Decision outcome

Outcome: close O2. Use one explicit Angel-owned authenticated encrypted vault at `${XDG_DATA_HOME:-$HOME/.local/share}/angel/credentials.v1.json`. Unlock from a no-echo TTY for attended use or an explicitly named inherited FD for unattended use. Do not call an ambient desktop keychain the headless contract. Never fall back to environment, plaintext, hosted custody, fixtures, or an empty keyring.

## Product implication

Target docs must replace “OS keychain” with the exact headless vault boundary. In local mode, the `angel` process can decrypt credentials; the user agent and MCP responses cannot. Root, the VM host, and hostile same-UID code remain outside the claim.

## Execution gates

- Implement versioned AES-256-GCM storage with bounded scrypt, atomic same-directory writes, locking, ownership/mode/symlink checks, and safe summaries only.
- Pass the exact 2 GB exe.dev memory/locking/tamper/restart suite.
- Run a separate disposable real Google PKCE callback test; this brief used synthetic credentials and closes storage, not provider callback type.
- Prove TTY and FD unlock errors, no argv/env leakage, no fallback, provider revocation/removal behavior, and honest secure-erasure limits.

## Evidence record

### O2 full record

Date: 2026-08-01  
Repository state: `evidence/ws-e-decision-briefs` at `6cc2ed5`

#### O2 full record: Question

How should headless Linux store and retrieve local OAuth credentials?

#### O2 full record: Answer

Use an Angel-owned encrypted local vault, not an assumed OS keychain. Keep the vault's unlock secret outside the vault. Accept that secret from a no-echo TTY for attended use or from one inherited file descriptor for unattended use. Decrypt only into the `angel` process, never print credential values, and fail closed when the key, file, authentication tag, scope set, or record identity is wrong.

Do not use an environment variable as the default secret handoff. Do not silently fall back to plaintext, hosted custody, fixtures, or a newly created empty keyring.

The real exe.dev spike supports this choice. Secret Service can be made to work, but a stock headless exe.dev VM has no session bus, keyring daemon, display, or login/PAM unlock. After installing 47 MB of packages, it still needs an explicit D-Bus session and an external master secret on every fresh session or boot. That is the same bootstrap problem as an encrypted file, with more moving parts.

#### O2 full record: Method

1. Read the repository contract and evidence:
   - `AGENTS.md`
   - `docs/product-ledger.html`, especially O2, C15, LR-009, G02, G03, and G06
   - `docs/aprd/README.md`, `docs/aprd/angel-cloud-aprd.html` terminology and local-run sections, and `docs/aprd/v2.1-cli-user-guide.md`
   - current CLI: `packages/core/src/cli/{index,commands,config,client}.ts` and `packages/core/README.md`
   - current managed OAuth/custody: `src/{custody,google-oauth,oauth-state}.ts`, `src/workers/{control,broker,credential-vault}.ts`
   - relevant scripts/manual: `scripts/google-read-proof.ts`, `src/google-read-proof-acceptance.ts`, `docs/google-read-proof-manual-journey.md`, and custody/OAuth tests under `tests/cloud/`
2. Inspected exe.dev's SSH REPL, authentication, VM lifecycle help, and current local environment.
3. Created a disposable, credential-free exe.dev Ubuntu VM.
4. Used only synthetic strings to test:
   - stock headless OS state;
   - Secret Service/libsecret before and after package installation;
   - D-Bus activation and locked-keyring behavior;
   - explicit headless keyring unlock, retrieval in a new session, wrong-key failure, and VM-restart retrieval;
   - a mode-0600 encrypted file with its passphrase supplied on an inherited FD, including no-key, wrong-key, tamper, new-SSH, and VM-restart cases;
   - environment and inherited-FD process handoff visibility.
5. Deleted the disposable VM and confirmed the repository remained unchanged.

No real OAuth client, refresh token, provider account, production endpoint, or repository secret was used.

#### O2 full record: Environment

##### O2 full record: Investigator host

- macOS client using OpenSSH.
- No local `exe`/`exedev` executable was installed.
- exe.dev authentication was available through the existing SSH identity. `ssh -o BatchMode=yes exe.dev whoami` succeeded; personal account output is intentionally omitted.
- exe.dev exposes its CLI as an SSH REPL. `ssh exe.dev help` listed `new`, `ls`, `ssh`, `restart`, and `rm`.

##### O2 full record: Disposable exe.dev VM

- Name: `angel-o2-20260802` (deleted after the spike). VM suffix uses UTC date 2026-08-02; the evidence run began on 2026-08-01 in America/Los_Angeles.
- Image: `ubuntu:24.04`; 1 CPU, 2 GB RAM, 10 GB disk.
- Kernel: Linux 6.12.93 x86_64.
- Login: `root`; SSH command had no TTY.
- PID 1: `exe-init`, not systemd.
- Initially absent/unset: `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `dbus-run-session`, `dbus-daemon`, `gnome-keyring-daemon`, `secret-tool`, and `keyctl`.
- Installed for the candidate test from Ubuntu Noble repositories:
  - `dbus-user-session 1.14.10-4ubuntu4.1`
  - `gnome-keyring 46.1-2ubuntu0.2`
  - `libsecret-tools 0.21.4-1build3`
  - `gnupg2 2.4.4-2ubuntu17.4`

#### O2 full record: Exact commands and sources

The synthetic credential was `synthetic-o2-refresh-token`; the synthetic unlock value was `synthetic-o2-master`.

##### O2 full record: exe.dev discovery and lifecycle

```sh
command -v exe || true
ssh -o BatchMode=yes exe.dev help
ssh -o BatchMode=yes exe.dev 'help new'
ssh -o BatchMode=yes exe.dev 'help ssh'
ssh -o BatchMode=yes exe.dev 'help rm'
ssh -o BatchMode=yes exe.dev whoami
ssh -o BatchMode=yes exe.dev ls

ssh -o BatchMode=yes exe.dev \
  "new --name=angel-o2-20260802 --image=ubuntu:24.04 --cpu=1 --memory=2GB --disk=10GB --no-email --comment='Angel O2 disposable headless Linux credential spike'"

ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  angel-o2-20260802.exe.xyz '<environment inspection commands>'
```

The attempted 1 GB VM creation failed clearly with `--memory must be at least 2 GB`; the successful command above used the minimum accepted size.

##### O2 full record: Candidate package installation and stock Secret Service test

```sh
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  dbus-user-session gnome-keyring libsecret-tools gnupg2 procps

printf synthetic-o2-refresh-token |
  timeout 8 secret-tool store --label='Angel O2' \
    application angel-o2 account disposable

HOME=/tmp/o2-keyring-auto timeout 12 dbus-run-session -- sh -c \
  "printf synthetic-o2-refresh-token | secret-tool store --label='Angel O2' application angel-o2 account disposable"
```

The installed D-Bus activation file was also inspected:

```sh
grep -E '^(Name|Exec)=' \
  /usr/share/dbus-1/services/org.freedesktop.secrets.service
```

It names `org.freedesktop.secrets` and executes `gnome-keyring-daemon --start --foreground --components=secrets`.

##### O2 full record: Explicit headless Secret Service unlock and retrieval

Write and read in one D-Bus session:

```sh
HOME=/tmp/o2-keyring-explicit dbus-run-session -- sh -c '
  printf synthetic-o2-master |
    gnome-keyring-daemon --unlock --components=secrets >/tmp/o2-gkd-write.env
  printf synthetic-o2-refresh-token |
    secret-tool store --label="Angel O2" application angel-o2 account disposable
  test "$(secret-tool lookup application angel-o2 account disposable)" = \
    synthetic-o2-refresh-token
'
```

A second `dbus-run-session` repeated only the explicit unlock and lookup. Separate cases omitted the unlock or supplied `wrong-master`. The VM was then restarted with:

```sh
ssh exe.dev 'restart angel-o2-20260802'
```

After restart, the same explicit unlock plus `secret-tool lookup` succeeded.

##### O2 full record: Encrypted-file candidate

The spike used GnuPG only as a concrete encrypted-file probe; it is not the recommended product file format.

```sh
install -d -m 700 /tmp/o2-file /tmp/o2-file/gnupg
chmod 700 /tmp/o2-file/gnupg
export GNUPGHOME=/tmp/o2-file/gnupg
umask 077

printf synthetic-o2-refresh-token |
  gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 \
      --output /tmp/o2-file/credentials.gpg 3<<'EOF'
synthetic-o2-master
EOF

out=$(gpg --quiet --batch --yes --pinentry-mode loopback \
  --passphrase-fd 3 --decrypt /tmp/o2-file/credentials.gpg 3<<'EOF'
synthetic-o2-master
EOF
)
test "$out" = synthetic-o2-refresh-token
```

The read was repeated in a new SSH command and after `ssh exe.dev restart`. No-key and wrong-key reads were run separately. One ciphertext byte was flipped with `od`, shell arithmetic, and `dd`, then decryption was retried.

##### O2 full record: Process/env handoff probe

```sh
env ANGEL_OAUTH_TOKEN=synthetic-o2-refresh-token \
  sh -c 'echo $$ >/tmp/o2-env.pid; sleep 20' </dev/null >/dev/null 2>&1 &
tr '\0' '\n' </proc/"$(cat /tmp/o2-env.pid)"/environ

sh -c '
  echo $$ >/tmp/o2-fd.pid
  sleep 3
  IFS= read -r token <&3
  printf %s "$token" | sha256sum
' 3<<'EOF' </dev/null >/tmp/o2-fd.result 2>&1 &
synthetic-o2-refresh-token
EOF

tr '\0' '\n' </proc/"$(cat /tmp/o2-fd.pid)"/environ
tr '\0' ' ' </proc/"$(cat /tmp/o2-fd.pid)"/cmdline
test -r /proc/"$(cat /tmp/o2-fd.pid)"/fd/3
```

##### O2 full record: Cleanup

```sh
ssh -o BatchMode=yes exe.dev 'rm angel-o2-20260802'
ssh -o BatchMode=yes exe.dev ls
git status --short
```

The VM no longer appeared in `ls`; `git status --short` was empty before writing this required evidence artifact.

##### O2 full record: Documentary sources

Repository sources listed in Method are the product truth for this investigation. External behavior was checked against:

- exe.dev's live SSH documentation: `ssh exe.dev doc customization` and `ssh exe.dev doc faq/how-exedev-works`.
- Secret Service API: <http://specifications.freedesktop.org/secret-service/latest/>.
- Ubuntu Noble `gnome-keyring-daemon(1)`: <https://manpages.ubuntu.com/manpages/noble/man1/gnome-keyring-daemon.1.html>. It states that `--unlock` reads a password from stdin and unlocks or creates the login keyring.
- Ubuntu Noble `dbus-run-session(1)`: <https://manpages.ubuntu.com/manpages/noble/man1/dbus-run-session.1.html>. It describes a private session bus for text-mode/SSH sessions whose lifetime matches the child program.

#### O2 full record: Verified results

##### O2 full record: Repository/current-product facts

1. The approved Ledger keeps O2 open and requires a real exe.dev spike before Linux storage is named as known. C15 and LR-009 say the APRD's OS-keychain and headless callback/retrieval assumptions are unproved.
2. The APRD and v2.1 CLI guide are target-state, unapproved documents. They currently say local tokens and Account management tokens live in the “OS keychain.”
3. The shipped core CLI implements build, publish, production deploy, and delete. It contains no local OAuth, Secret Service, keyring, encrypted local vault, or `angel serve` implementation.
4. Current local publish/deploy auth comes from `ANGEL_MANAGEMENT_TOKEN` and optional `ANGEL_ACCESS_TOKEN` environment variables.
5. Current managed Google custody is not a local precedent for key bootstrapping: Broker holds a separately configured 32-byte KEK, wraps a per-Account DEK, encrypts client secrets and refresh tokens with AES-GCM and record-bound AAD, and exposes only safe summaries outside internal leases.
6. Current Google OAuth uses PKCE, opaque one-use state with a ten-minute lifetime, verifies identity and required scopes, and requires a refresh token. The live user manual says managed custody setup is browser-only and has no headless API.

##### O2 full record: Real exe.dev facts

1. A stock `ubuntu:24.04` exe.dev VM had no session bus, keyring service, display, runtime directory, or keyring tools.
2. After installing libsecret and GNOME Keyring, plain `secret-tool store` failed:

   ```text
   secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY
   ```

3. `dbus-run-session` alone started D-Bus and activated `org.freedesktop.secrets`, but storing failed. GNOME's system prompter could not open a display, and `secret-tool` reported that the login collection did not exist.
4. Explicitly piping a non-empty master value to `gnome-keyring-daemon --unlock --components=secrets` made store and lookup work. The persistent files were mode 0600, and a byte scan did not find the synthetic token.
5. A new D-Bus session without explicit unlock failed; a new session with the same unlock value succeeded; a wrong unlock value failed. The same explicit unlock and lookup succeeded after an exe.dev VM restart.
6. Therefore Secret Service is technically possible, but it is not ambient OS capability on this headless machine. It needs packages, a D-Bus and daemon lifecycle, and an external unlock secret.
7. The encrypted-file candidate was mode 0600, did not contain the synthetic plaintext marker, and returned the exact value in a new SSH process and after VM restart when its passphrase arrived through FD 3.
8. Encrypted-file reads with no passphrase or a wrong passphrase returned no plaintext and nonzero status.
9. The GnuPG tamper probe returned nonzero and warned that the message had been manipulated, but it had already streamed 26 bytes to stdout. Product code must therefore use an authenticated-decryption API that withholds plaintext until tag verification, not stream unauthenticated plaintext to provider code.
10. An environment handoff was inherited by the child and readable by another same-UID process through `/proc/<pid>/environ`. It was absent in a new SSH session, so it is not durable.
11. An inherited FD kept the marker out of argv and the environment and delivered the exact bytes. Another same-UID process could still open `/proc/<pid>/fd/3`; an FD is a safer transport, not a same-UID security boundary.

#### O2 full record: Threat and operability comparison

| Candidate | Disk/backup exposure | Same-UID process exposure | Restart/unattended behavior | Headless operability | Result |
|---|---|---|---|---|---|
| Ambient Secret Service/keyring | Good only when the collection has a non-empty external unlock secret | Loses once unlocked; clients on the bus can request items under service policy | Needs D-Bus, daemon, and unlock setup each fresh session/boot on exe.dev | Fails stock; `dbus-run-session` alone also fails because prompting needs a display | Do not make this the headless default |
| Angel-owned authenticated encrypted file | Ciphertext and metadata envelope survive disk/backup theft; weak passphrases still permit offline guessing | Loses while unlocked to same-UID/root compromise, as all local options do | Durable; needs TTY/FD unlock each process start or a supervisor-held secret | Works without a desktop/session bus; product controls errors and file format | Recommended |
| OAuth credential in environment | No Angel-created disk file, but supervisors/logs may persist it | Directly visible in `/proc/<pid>/environ`, inherited by children | Not durable; supervisor must inject every start | Easy, but broad and accidental exposure is poor | Explicit compatibility override at most; not default |
| OAuth credential/process key over inherited FD | No argv/env copy; one-shot transport can be closed after read | Same UID/root can still inspect the FD or process | Not storage; supervisor or owner must supply it every start | Works over SSH and under a service manager | Recommended unlock transport, not credential store |
| Plain mode-0600 file or encryption key beside ciphertext | Filesystem ACL only | Same UID/root reads it | Durable and easy | Works | Reject as “encrypted custody”; it is plaintext-equivalent for disk compromise |

Security boundary: none of these options protects against root, the VM host administrator, or hostile code already running as the Angel user's UID while credentials are unlocked. The useful encrypted-file claim is narrower: theft of the vault file, home directory backup, or detached disk does not itself reveal OAuth credentials.

#### O2 full record: Recommendation

Choose one explicit headless-Linux backend for WS2: an Angel-owned authenticated encrypted vault. Do not probe several backends and silently select one. Secret Service may remain a later desktop integration, but “OS keychain” must not describe the headless contract.

This is the smallest design that is both real on exe.dev and honest about key bootstrapping. Secret Service adds a package and daemon stack but still requires the same external unlock secret. Environment-only custody is easier but is neither durable nor narrow.

#### O2 full record: Exact storage and retrieval contract

This is the contract O2 supports; implementation remains forbidden until WS2 approval.

##### O2 full record: Location and permissions

- Vault path: `${XDG_DATA_HOME:-$HOME/.local/share}/angel/credentials.v1.json`.
- Parent directories: mode 0700, owned by the effective user; reject symlinks and wrong ownership.
- Vault file: regular file, mode 0600, owned by the effective user; reject group/other bits instead of repairing silently during read.
- The ordinary project and `angel.json` contain only Connection nicknames, never credentials or vault keys.

##### O2 full record: Encrypted record

- One versioned vault contains all local grant profiles so nicknames and provider identity labels are not leaked through filenames.
- Cleartext envelope fields: format version, KDF name and parameters, random salt, cipher name, random nonce, and ciphertext; binary values use canonical base64url.
- KDF: scrypt to 32 bytes with a fresh 16-byte salt per vault rewrite, `N=131072`, `r=8`, `p=1`, and an implementation memory ceiling of at least 256 MiB.
- Cipher: AES-256-GCM with a fresh 12-byte nonce, 128-bit tag, and AAD exactly `angel:local-oauth:v1`.
- Encrypted payload per local grant profile: provider, nickname, OAuth client ID, OAuth client secret where the provider requires one, stable provider subject, owner-safe display label, exact granted scopes, refresh token, and creation/update timestamps.
- No access token is persisted; refresh in memory when needed.

The existing managed `EnvelopeCustody` code proves this repository already uses AES-GCM, random 12-byte IVs, 128-bit tags, and AAD-bound records. Local code must not reuse its cloud KEK assumption: headless unlock is a different boundary.

##### O2 full record: Unlock input

- Attended: read the vault passphrase from `/dev/tty` with echo disabled. Refuse if no TTY exists; never fall back to stdin when stdin may carry MCP data.
- Unattended: accept only a caller-opened numeric FD through an explicit option such as `--credential-key-fd <n>`; read once, close immediately, and never put the value in argv or an environment variable.
- The caller may source that FD from a real external secret manager or service supervisor. Angel never stores the passphrase/key beside the vault.
- If no unlock source is available, fail with a specific action: attach a TTY or configure the FD. Do not begin provider consent or cloud work.

##### O2 full record: Write

1. Obtain human consent and exchange the OAuth code entirely in memory.
2. Verify provider identity and the exact required-scope floor before storage, matching current managed behavior.
3. Acquire the vault lock; decrypt and authenticate any existing vault before changing it.
4. Replace only the named local grant profile. A nickname bound to a different provider identity/client fails unless the owner explicitly removes or renames it.
5. Encrypt the full new payload with fresh salt and nonce.
6. Write a mode-0600 temporary file in the same directory, flush it, atomically rename it over the vault, then flush the directory.
7. Release the lock and best-effort clear temporary plaintext byte buffers. Print only provider, nickname, safe identity label, granted scopes, health, and vault path.

A failed exchange, missing scope, wrong identity, encryption failure, or atomic-write failure leaves the previous vault bytes unchanged. Never revoke an existing provider-wide grant as automatic rollback, matching the current Google custody rule.

##### O2 full record: Read/use

1. Validate ownership, regular-file type, mode, envelope shape, version, KDF bounds, nonce length, and ciphertext size before expensive work.
2. Acquire the unlock secret from TTY or FD and derive the 32-byte key.
3. Authenticate and decrypt the complete payload before exposing any plaintext to provider code.
4. Select exactly one local grant profile by nickname; verify provider and scope coverage.
5. Keep the client secret and refresh token only in the `angel serve` process; obtain short-lived access tokens in memory.
6. Return only safe summaries to CLI/MCP surfaces. Close the inherited FD and best-effort clear key/plaintext buffers after use and on shutdown.
7. Wrong key, changed ciphertext/AAD, malformed payload, missing nickname, or missing scope fails closed. There is no keyring, environment, cloud, or fixture fallback.

##### O2 full record: Rotation, loss, and removal

- Reauthorization atomically replaces the same local grant profile only after identity/client continuity checks.
- A lost passphrase has no recovery path. The owner must revoke/re-authorize at the provider and create a new vault.
- Removal deletes the local record only after any requested upstream revocation succeeds. If secure erasure cannot be guaranteed on the filesystem, docs must say deletion removes the live file/reference, not every historical block or backup.

#### O2 full record: Product implication

1. The target APRD/CLI wording “tokens live in the OS keychain” is false for headless exe.dev and must change before WS2 approval. No shipped manual should change now.
2. O3 chose explicit `--local`/`--cloud` consent syntax. Implementation must never infer custody from keyring availability or machine type.
3. `angel apps connect` and `angel serve` need one coherent local grant lifecycle. The current target guide is internally split: `apps connect` describes Broker custody while `serve` says it stores a local grant.
4. “Credentials go in, never out” needs a local boundary statement. In local mode, the `angel` process necessarily decrypts credentials; they remain unavailable to the user's agent/MCP responses, not unavailable to the machine owner or same-UID process.
5. Headless unattended operation requires an operator-owned secret source. Angel should support FD injection, not pretend encryption can bootstrap its own key.
6. Current environment-based management auth is separate shipped behavior and should not be cited as evidence that local OAuth-in-env is safe.

#### O2 full record: Remaining gap

- No real Google OAuth consent was run. There was no approved disposable OAuth client/provider identity, and using current personal or production custody would have violated the task. Storage and retrieval behavior was tested with synthetic bytes of the same class and lifecycle.
- The separate local OAuth callback question is not closed by this storage spike. In particular, the APRD claim that one OAuth client works for both hosted HTTPS callbacks and headless-local consent still needs a provider-valid test. The smallest safe closure test is: create a disposable Google OAuth client of the proposed application type, register the exact proposed loopback or HTTPS redirect, run PKCE from a fresh exe.dev VM through the documented browser handoff, exchange once, store the returned refresh token under this vault contract, restart the VM, unlock via FD, refresh one access token, revoke it, and delete the client/VM. Save only pass/fail and redacted metadata.
- The recommended scrypt parameters and atomic-write/locking implementation need a 2 GB exe.dev implementation test before shipping. That is implementation proof, not an open storage-backend decision.
- Desktop Linux behavior outside this Ubuntu/exe.dev shape was not tested; O2 asks specifically about headless Linux.

#### O2 full record: Can O2 close?

**Yes — O2 can close for the storage/retrieval decision.** The required real exe.dev evidence now distinguishes the candidates and supports an exact headless contract: authenticated encrypted local vault plus TTY/FD unlock, with no ambient Secret Service or environment fallback.

The Google callback/client-type issue should remain a separate explicit blocker (the callback half of LR-009, tracked as Ledger contradiction C16), not be hidden inside O2 or treated as proven by this synthetic custody test.
