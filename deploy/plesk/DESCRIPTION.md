# KitsuneGIT Web for Plesk

Deploy and operate a private KitsuneGIT Web instance from Plesk. The extension installs an isolated system service, persistent repository storage, an administrator token, health checks, and a panel link.

The extension deploys Smart HTTP and SSH repositories, LFS, signed Git-native collaboration refs, GitHub/GitLab/Gitea Forge Mesh, Change Intelligence, production IAM, explainable access, stacked review workflows, portable change bundles, Attention, external quality gates, registries, SQLite WAL metadata, audit/backup features, expiring Plesk previews, privacy-routed AI, and local-first KitsuneGIT Desktop connectivity. CI/CD is intentionally delegated to the future external Kitsune Test integration.

Linux with systemd, Node.js 22+, Git 2.39+, `curl`, `tar`, nginx, a free TCP port for Git SSH, and a dedicated Plesk domain with TLS is required. The extension refuses to overwrite pre-existing custom nginx directives.
