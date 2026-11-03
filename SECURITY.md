# Security policy

Never include private keys, seeds, passphrases, RPC credentials or encrypted-vault passphrases in issues, PRs, screenshots or logs. Report a security problem privately through GitHub private vulnerability reporting if the repository owner has enabled it. Otherwise contact the repository owner through a verified private channel; do not publish a working secret.

The old repository history contains published secrets and a dependency with configuration-file exfiltration. Removing files from the new tree cannot revoke those secrets or erase existing clones. Treat all old committed credentials as public and never reuse them. Credentials controlled by their actual owner must be replaced/revoked through the relevant provider. Viewing this repository alone does not establish that your personal keys were stolen.

The generic RPC client and default signing screen refuse broadcast. The isolated step-2 native devnet executor requires a verified in-memory capability, explicit approval, fresh simulation, and durable pre-send recording. Expanding it to additional routes is a security-sensitive code change. Add no environment-based escape hatch. CI/secret screening and dependency advisories are useful but cannot certify absence of malicious code. Require source review and meaningful adversarial tests for signing, network, storage and dependency changes.

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


Devnet execution is selected explicitly with a separate journal directory. Preserve
that directory: its intent/attempt records and payer leases prevent this application
from automatically paying again after ambiguous RPC responses or restarts. Missing
history on one RPC is not proof of non-execution. Signed payloads are not journaled,
so prepared operations cannot be silently resumed/re-signed after a restart. Recovery
can abandon a never-submitted operation or observe the original signature; it never
sends. State corruption, unresolved history, deletion or manual out-of-app transfers
require manual reconciliation. No live acceptance testing has been completed.
