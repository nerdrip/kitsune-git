# 1.4.0-8

* Replace the central Suite manifest self-update with a verified repository checkout, fast-forward and pinned-commit package.

# 1.4.0-7

* Normalize deployed code permissions for the unprivileged service account, provide the selected Node.js runtime in the systemd PATH, allow a longer startup window, and include service state plus bounded journal output when readiness fails.

# 1.4.0-6

* Discover Node.js installations managed by Plesk under `/opt/plesk/node`, select the newest available runtime, invoke its matching npm CLI, and pin the absolute Node.js path in generated systemd units.

# 1.4.0-5

* Fixed section navigation by linking every tab to the explicit Plesk extension controller route.

# 1.4.0-4

* Raised the minimum Node.js version to 22.13 so the built-in SQLite backend is available without experimental flags.

# 1.4.0-3

* Fixed the Linux service entrypoint in Windows-built packages by enforcing LF line endings and rejecting CRLF during packaging.

# 1.4.0-2

* Fixed process execution on Plesk hosts whose system PHP is older than 7.4 while retaining shell-safe argument escaping.

# 1.4.0-1

* Rebuilt the extension as a complete Plesk deployment manager with clear status, deployment, repository/domain, access, and diagnostics sections.
* Added active Plesk domain selection and managed nginx reverse-proxy generation for HTTP, WebSocket, Smart HTTP, and Git LFS traffic.
* Added public HTTPS, private HTTPS token, generated deployment key, and custom SSH key source authentication without leaking credentials to URLs or logs.
* Added staged deployment, prerequisite checks, readiness verification, atomic activation, rollback, service restart, admin-token rotation, and persistent runtime state.
* Added independent verified plugin self-update while retaining Kitsune Hub Suite navigation and central management compatibility.

# 1.3.0-2

* Added the shared Kitsune Plesk Suite shell and direct central-management navigation.
* Keeps a standalone Plesk menu entry only when Kitsune Hub is unavailable.

# 1.3.0

* Added signed Git-native collaboration refs, Forge Mesh, Change Intelligence, portable change bundles, policy evidence, and Attention Engine.
* Added multi-provider privacy routing, path exclusion, secret redaction, byte budgets, and auditable AI data manifests.
* Expanded encrypted Desktop offline work to merge requests and review comments with publish/conflict workflows.

# 1.2.0

* Added a separate loopback-only, HMAC-authenticated preview provisioner with automatic expiry.
* Added production IAM, universal mirrors, stacked reviews, external quality gates, and private AI configuration support.
* CI/CD remains outside KitsuneGIT and is reserved for the future Kitsune Test adapter.

# 1.1.0

* Added configurable Git SSH transport with managed user keys and generated Ed25519 host identity.
* Added SQLite WAL metadata, package/OCI registries, quotas, boards, notifications, and search.
* Kept all CI/CD and runners outside the extension for future Kitsune Test integration.

# 1.0.0

* Initial Plesk Obsidian extension.
* Verified release deployment with SHA-256.
* systemd service installation, restart, status, upgrade, and clean service removal.
* Administrator-only display of the Desktop/API token without writing it to systemd logs.
* Persistent data remains under `/var/lib/kitsune-git` when the extension is removed; application files and secrets are removed.
