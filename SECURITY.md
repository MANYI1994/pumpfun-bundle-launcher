# Security policy

Never include private keys, seeds, passphrases, RPC credentials or encrypted-vault passphrases in issues, PRs, screenshots or logs. Report a security problem privately through GitHub private vulnerability reporting if the repository owner has enabled it. Otherwise contact the repository owner through a verified private channel; do not publish a working secret.

The old repository history contains published secrets and a dependency with configuration-file exfiltration. Removing files from the new tree cannot revoke those secrets or erase existing clones. Treat all old committed credentials as public and never reuse them. Credentials controlled by their actual owner must be replaced/revoked through the relevant provider. Viewing this repository alone does not establish that your personal keys were stolen.

This security preview intentionally refuses broadcast. A future submission adapter is a security-sensitive change, not a configuration toggle. Add no environment-based escape hatch. CI/secret screening and dependency advisories are useful but cannot certify absence of malicious code. Require source review and meaningful adversarial tests for signing, network, storage and dependency changes.

Threat boundary: encryption protects a locked vault on disk, not against same-user/root compromise, a malicious Node runtime, compromised hardware, an unlocked signer process or hostile changes to the source/dependency lockfile. Use an isolated unprivileged account, offline encrypted backups and an external main-wallet signer in a future execution release.


The step-1 browser signing app is a local loopback-only tool. Its API requires the
exact origin/Host and a random per-process session capability; it rejects cross-site
requests, arbitrary input fields and arbitrary transaction uploads. Static resources
have no remote dependencies, a restrictive CSP, no framing and no caching. No key
material enters this UI/server. A compromised wallet extension, same-user process,
modified browser page or Node runtime is outside this application's isolation boundary.
The extension may perform its own network requests; this code cannot control those.
Never share the printed session URL. Review expiry does not revoke an already
produced signature on chain. Use a disposable devnet account, not a valuable wallet.
