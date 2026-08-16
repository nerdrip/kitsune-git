# KitsuneGIT Web

KitsuneGIT Web is the server counterpart to the Electron desktop client. It is deliberately a separate process: the desktop remains a local Git tool, while the server owns hosted bare repositories, collaboration metadata, imports, and mirror scheduling.

## Run locally

Node.js 22+ and Git are required.

```powershell
$env:KITSUNE_ADMIN_TOKEN = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
$env:KITSUNE_SECRET_KEY = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
npm run web
```

Open `http://127.0.0.1:4780` and sign in with a user password/passkey. The bootstrap administrator token remains available for initial administration and automation, but the browser keeps it only in memory. Data defaults to `.kitsune-web`; set `KITSUNE_DATA_PATH` for production.

## Containers

Create an `.env` file containing two independently generated values:

```dotenv
KITSUNE_ADMIN_TOKEN=<at least 24 random characters>
KITSUNE_SECRET_KEY=<exactly 64 hexadecimal characters>
KITSUNE_PUBLIC_URL=https://git.example.com
KITSUNE_SSH_PORT=2222
KITSUNE_METADATA_BACKEND=sqlite
KITSUNE_PROJECT_STORAGE_LIMIT_BYTES=0
```

Then run `docker compose -f compose.web.yml up -d --build`. HTTP publishes only to loopback so a TLS reverse proxy remains mandatory; TCP port 2222 is exposed directly for Git SSH.

## API and Git URLs

API clients use `Authorization: Bearer <administrator-or-personal-token>`. Browsers use an `HttpOnly`, `SameSite=Strict` session cookie and send the session's `X-CSRF-Token` on mutations. Passwords use memory-hard scrypt hashes. Invitations, reset tokens, TOTP, passkeys/WebAuthn, session revocation, OIDC with PKCE/nonce/JWKS verification, and LDAPS are supported through the matching `KITSUNE_WEBAUTHN_*`, `KITSUNE_OIDC_*`, or `KITSUNE_LDAP_*` variables.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Liveness check |
| `GET` | `/api/v1/ready` | Metadata-backend readiness |
| `GET` | `/api/v1/me` | Current token identity |
| `GET`, `POST` | `/api/v1/projects` | List or create projects |
| `POST` | `/api/v1/imports` | Import GitHub, GitLab, or a Git URL; optionally enable a pull mirror |
| `GET` | `/api/v1/projects/:id` | Repository refs and commit count |
| `POST` | `/api/v1/projects/:id/mirror/sync` | Force a mirror update |
| `GET` | `/api/v1/projects/:id/mirror/conflicts` | Inspect divergent refs/metadata for explicit resolution |
| `GET`, `POST` | `/api/v1/projects/:id/issues` | List or create issues |
| `PATCH` | `/api/v1/projects/:id/issues/:iid` | Edit or close an issue |
| `GET`, `POST` | `/api/v1/projects/:id/merge-requests` | List or create merge requests |
| `POST` | `/api/v1/projects/:id/merge-requests/:iid/approve` | Approve a merge request |
| `POST` | `/api/v1/projects/:id/merge-requests/:iid/merge` | Atomically fast-forward or create a merge commit |
| `GET` | `/api/v1/projects/:id/merge-requests/graph` | Stacked-change dependency graph and readiness |
| `GET`, `POST` | `/api/v1/projects/:id/merge-queue` | Inspect or enqueue changes; processing remains policy-gated |
| `GET`, `POST` | `/api/v1/projects/:id/quality-gates` | Configure signed external checks, including future Kitsune Test |
| `GET`, `POST` | `/api/v1/projects/:id/previews` | Inspect or provision expiring Plesk reverse-proxy previews |
| `GET`, `PUT` | `/api/v1/projects/:id/ai` | Inspect/configure explicit per-project AI data scopes |
| `POST` | `/api/v1/projects/:id/merge-requests/:iid/ai/summary` | Advisory summary with a data-transmission manifest |
| `GET`, `POST` | `/api/v1/projects/:id/merge-requests/:iid/threads` | Inline review threads anchored to file, side, line and commit |
| `POST` | `/api/v1/projects/:id/merge-requests/:iid/threads/:thread/replies` | Reply to a review thread |
| `POST` | `/api/v1/projects/:id/merge-requests/:iid/threads/:thread/resolve` | Resolve or reopen a thread; unresolved threads block merge |
| `GET`, `POST` | `/api/v1/projects/:id/protected-branches` | List or configure approval and push-role rules |
| `GET`, `POST` | `/api/v1/projects/:id/releases` | Releases tied to verified Git tags |
| `GET`, `POST` | `/api/v1/projects/:id/wiki` | Versioned project wiki pages |
| `GET`, `POST` | `/api/v1/projects/:id/snippets` | Project snippets up to 1 MiB |
| `GET`, `POST` | `/api/v1/projects/:id/milestones` | Project milestones |
| `GET`, `POST` | `/api/v1/projects/:id/webhooks` | Signed HTTPS webhooks and recent delivery status |
| `GET` | `/api/v1/audit` | Recent immutable audit events |
| `GET`, `POST` | `/api/v1/users` | Admin-only user management; creation returns a personal token once |
| `GET`, `POST` | `/api/v1/groups` | Groups and nested groups with inherited project permissions |
| `GET`, `POST` | `/api/v1/groups/:id/members` | Group membership and guest-to-owner roles |
| `POST` | `/api/v1/users/:id/tokens` | Issue a new personal token |
| `GET`, `POST` | `/api/v1/users/:id/ssh-keys` | List or register the user's public SSH keys |
| `DELETE` | `/api/v1/users/:id/ssh-keys/:keyId` | Revoke an SSH key |
| `GET`, `POST` | `/api/v1/projects/:id/members` | List members or assign guest/reporter/developer/maintainer/owner roles |
| `GET`, `PUT` | `/api/v1/projects/:id/storage` | Storage breakdown or owner-managed quota |
| `GET` | `/api/v1/projects/:id/packages` | Generic package inventory |
| `PUT`, `GET` | `/api/v1/projects/:id/packages/generic/:name/:version/:file` | Publish/download immutable package files; optional `X-Checksum-Sha256` |
| `DELETE` | `/api/v1/projects/:id/packages/:packageId` | Remove a package as maintainer |
| `GET`, `POST` | `/api/v1/projects/:id/boards` | Label-backed issue boards |
| `POST` | `/api/v1/projects/:id/boards/:boardId/issues/:iid/move` | Move an issue between lists |
| `GET` | `/api/v1/search?q=...` | Permission-filtered projects, work items, and default-branch code search |
| `GET` | `/api/v1/notifications` | Personal notification inbox (`unread=true` optional) |
| `POST` | `/api/v1/notifications/:id/read` | Mark a notification read |
| `GET` | `/api/v1/system/capabilities` | Admin-only backend and integration capabilities |

### Sovereign Forge APIs

| Method | Route | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/api/v1/projects/:id/collaboration-ref` | Verify or publish the signed `refs/kitsune/collaboration` snapshot |
| `POST` | `/api/v1/projects/:id/collaboration-ref/import` | Import missing collaboration objects and surface divergence as conflicts |
| `GET`, `POST` | `/api/v1/projects/:id/forge-mesh/remotes` | Configure multiple GitHub, GitLab, Gitea, or plain Git peers |
| `POST` | `/api/v1/projects/:id/forge-mesh/remotes/:remote/sync` | Synchronize a peer according to code and metadata authority |
| `POST` | `/api/v1/projects/:id/forge-mesh/remotes/:remote/conflicts/:conflict/resolve` | Apply the selected side of a mesh conflict |
| `GET` | `/api/v1/change-intelligence/catalog` | Cross-project service/package dependency graph |
| `GET` | `/api/v1/projects/:id/merge-requests/:iid/impact` | Explain risk and transitive downstream blast radius |
| `GET` | `/api/v1/projects/:id/merge-requests/:iid/reviewers/suggest` | CODEOWNERS-aware reviewer load and heuristic review time |
| `GET` | `/api/v1/projects/:id/policies/forecast` | Future access changes caused by expiring membership |
| `GET`, `POST` | `/api/v1/projects/:id/policy-evidence` | Signed, source-SHA-bound merge-policy evidence |
| `GET`, `POST` | `/api/v1/projects/:id/change-bundles` | List or create signed portable change bundles |
| `GET` | `/api/v1/projects/:id/change-bundles/:bundle/download` | Download a `.kcb` with native Git data and review evidence |
| `POST` | `/api/v1/projects/:id/change-bundles/import` | Verify and import a `.kcb` into `kitsune-import/*` |
| `GET` | `/api/v1/attention/digest` | Risk-ranked personal work digest |

Git Smart HTTP is available at `/git/<namespace>/<project>.git`. Public projects allow anonymous fetch. Private fetch and every push use HTTP Basic authentication; the username is arbitrary and the administrator or personal token is the password. The same repository URL implements the Git LFS Batch API with streamed, SHA-256-verified object uploads.

Set `KITSUNE_SSH_PORT` to enable the dedicated SSH endpoint (disabled by default outside the supplied Docker/Plesk configurations). Register a public key through the API and clone `ssh://git@host:port/<namespace>/<project>.git`. Only Git upload/receive commands are accepted—there is no interactive shell. Push authorization and protected-branch rules use the same direct and inherited group roles as HTTP.

The OCI Distribution API is served under `/v2/<namespace>/<project>`. Authenticate `docker login` with any username and an administrator/personal token as the password, then push or pull normal OCI/Docker manifests and layers. Project roles control pull and push. Generic packages are separate immutable artifacts and accept an optional client-supplied SHA-256 checksum.

The same API accepts personal tokens. Project access follows `guest`, `reporter`, `developer`, `maintainer`, and `owner` roles; new projects automatically assign their creator as owner. Tokens are stored only as SHA-256 hashes and are displayed once when created.

GitHub/GitLab imports copy all Git refs and, when the provider is selected, repository description, visibility, default branch, topics, issues, and pull/merge request metadata. Mirrors can pull, push, or synchronize bidirectionally. Each ref is compared with the last shared snapshot; a true two-sided divergence becomes a resolvable conflict instead of a destructive overwrite. External identities are retained for metadata reconciliation. A provider token is used transiently or persisted only as AES-256-GCM ciphertext under `KITSUNE_SECRET_KEY`; API responses never expose it.

## Policies, reviews, and external checks

Direct, nested-group, and time-limited memberships are combined into an explainable permission decision. Owners can simulate a decision before applying it. Rulesets and `CODEOWNERS` can require approvals/reviewers, dismiss approvals after the source commit changes, require the merge queue, and require named external quality gates. The server contains no runner and executes no pipeline jobs: it only emits signed requests and accepts fresh HMAC-signed statuses from systems such as the future Kitsune Test integration.

Merge requests may depend on other merge requests. The Change Graph exposes this stack, the queue waits for dependencies and policies, and semantic diffs group changed hunks by detected symbols. Desktop synchronizes encrypted, versioned offline issue/MR/review drafts; concurrent edits are surfaced as conflicts rather than silently overwritten.

## Git-native collaboration and Forge Mesh

KitsuneGIT serializes project collaboration metadata into canonical JSON, signs it with the instance Ed25519 identity, stores it as a real Git blob, and updates `refs/kitsune/collaboration`. Universal and mesh synchronization include this ref, while direct user pushes to the protected namespace are rejected. Reading verifies the signature and reports the public-key fingerprint. Import never silently overwrites divergence: missing objects are added and differences become explicit collaboration conflicts. The private signing key lives under the instance data directory and must be included in encrypted operational backups.

Forge Mesh adds multiple peers to one project. Every peer independently selects `observe`, `pull`, `push`, or `bidirectional` code flow and `local`, `remote`, or `observe` metadata authority. Credentials remain AES-256-GCM encrypted. A shared ref baseline distinguishes unilateral updates from true two-sided divergence. GitHub, GitLab, Gitea, and plain Git are supported; metadata keeps peer-specific external identities.

Change Intelligence builds an explicit cross-project service graph and infers JavaScript package relationships. Merge-request impact uses semantic diff, changed symbols, CODEOWNERS, security/schema/API paths, change volume, and transitive consumers. Scores are explainable heuristics—not test results. Kitsune Test remains responsible for executing future checks.

Policy forecasts evaluate access immediately before and after scheduled membership expiry. Evidence binds approvals, rulesets, CODEOWNERS, unresolved discussions, external gate statuses, and the source commit into an Ed25519-signed document. Portable `.kcb` files combine that evidence with review metadata and a SHA-256-verified native Git bundle. Import always targets a new `kitsune-import/*` branch.

The Attention Engine ranks blocked mirrors, failed gates, waiting queue entries, unresolved discussions, and upcoming access changes. Items can be acknowledged or snoozed. Reviewer suggestions account for required owners and current load; predicted time is explicitly marked as heuristic.

## Private AI (optional)

AI is disabled globally unless a provider is configured. The legacy single-provider variables are `KITSUNE_AI_PROVIDER`, `KITSUNE_AI_BASE_URL`, `KITSUNE_AI_MODEL`, and optional `KITSUNE_AI_API_KEY`. `KITSUNE_AI_PROVIDERS_JSON` configures up to 20 named `ollama` or `openai-compatible` providers with independent residency, byte limits, and cost hints. Loopback HTTP is accepted for local models; otherwise HTTPS is mandatory. Each project owner selects scopes, permitted providers, routing, local-first code policy, excluded paths, and a monthly byte budget. Built-in secret redaction replaces detected credentials with non-reversible fingerprints. Every advisory run reports original/sent bytes, redactions, excluded files, residency, and estimated cost. AI cannot approve or merge.

## Desktop connection

Open a repository in KitsuneGIT Desktop, choose **Advanced Repository Tools → KitsuneGIT Web**, then enter the instance URL and administrator token. The token is encrypted with the operating-system credential store. Projects can be listed and cloned from the same dialog; clone authentication uses an ephemeral askpass process and is removed from the active Git environment immediately afterward.

## Plesk

Run `npm run build:plesk`, then upload `dist/KitsuneGIT-Plesk-1.3.0.zip` in **Extensions**. The server must provide Linux, systemd, Node.js 22+, npm, Git, curl, tar, nginx, and an existing dedicated domain with a valid Plesk TLS certificate.

The extension verifies the release archive SHA-256, installs the unprivileged web service plus a separate loopback-only, HMAC-authenticated Plesk preview helper, generates administrator/encryption/preview secrets and an Ed25519 SSH host key, and adds a streaming nginx reverse proxy suitable for large Git pushes. The helper alone runs as root and accepts narrowly validated create/delete operations for managed subdomains. Preview routes proxy an application already deployed elsewhere; this is not a build or CI engine. Expired previews are removed automatically. The extension refuses to overwrite existing custom nginx directives and preserves repositories in `/var/lib/kitsune-git` on removal.

## Backup and restore

Stop writes (or stop the service for a fully consistent snapshot), then run `npm run web:backup -- /safe/path/kitsune-backup.tar.gz`. Restore deliberately refuses to overwrite data: point `KITSUNE_DATA_PATH` at a new empty directory and run `npm run web:restore -- /safe/path/kitsune-backup.tar.gz`. The archive contains the metadata database, bare repositories, LFS objects, SSH host identity, encrypted mirror credentials, and collaboration content. Keep the instance environment file with `KITSUNE_SECRET_KEY` in a separate secret backup; encrypted mirror credentials cannot be recovered without it.

## Storage and scaling

`KITSUNE_METADATA_BACKEND=json` preserves the portable legacy single-writer database. Docker and Plesk default to `sqlite`, which uses WAL transactions, cross-process scheduler leases, and fresh snapshots so multiple application processes on one shared host cannot lose metadata updates. The readiness and capabilities endpoints expose the active mode. Repositories and large objects currently use the shared filesystem; multi-host HA therefore requires a filesystem with coherent locking. An external PostgreSQL/object-storage deployment is still future work and is reported honestly rather than emulated.

Existing JSON installations are never switched silently. Stop the service, back up the data directory, run `npm run web:migrate-sqlite`, set `KITSUNE_METADATA_BACKEND=sqlite`, and restart. The migration refuses to overwrite an existing SQLite database.

`KITSUNE_PROJECT_STORAGE_LIMIT_BYTES` sets the default project quota (`0` means unlimited). Owners can override it through the storage endpoint. Usage includes Git objects, LFS, generic packages, and container-registry blobs/manifests; API uploads and Git pre-receive hooks enforce it.

## Scope and roadmap

The current server is a broad functional foundation, not a claim of complete GitLab feature parity. Delivered now also includes production-oriented session IAM, passkeys/TOTP/OIDC/LDAPS, explainable and expiring access, rulesets/CODEOWNERS, bidirectional conflict-aware mirrors, project metadata export, stacked changes, semantic review, merge queue, external quality gates, encrypted offline Desktop drafts, Plesk previews, and private pluggable AI.

Remaining large compatibility layers include federation, external PostgreSQL/object-storage backends, multi-host high availability, advanced package formats, epics/roadmaps, compliance workflows, and deeper administration. CI/CD intentionally belongs to Kitsune Test and will be added later only as an external integration.
