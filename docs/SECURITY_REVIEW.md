# Remediation review — 3 November 2026

## Verdict and release scope

**Security rebuild preview only. Do not fund it or use it to launch/trade.** The confirmed credential theft is removed from this branch. Known unsafe execution code and its dependency tree have been retired. The enabled CLI provides encrypted operational-wallet creation/listing, review-only plans and read-only devnet status checks. Offline transaction candidate construction and full-signature verification have regression tests.

**Live token creation/buying/selling is not restored.** There is no Jito transport, PumpSwap execution, image uploader, Flash, external treasury signer or broadcast implementation. The current curve builder is an offline candidate. These missing integrations are explicit release blockers, not finished features, and they cannot be enabled by a configuration flag.

This is not a declaration that no code-related risk exists. It records what was changed, what was checked and what remains outside assurance. The same engineer performed remediation and review; this is not an independent third-party audit.

## Issue disposition

| Original finding | Disposition in this branch |
|---|---|
| `jsconvict` steals config and `.env` | Removed from code, manifest and lockfile. Startup access regression test rejects unexpected config/network activity. |
| Console private-key output | Removed. CLI prints only public wallet fields or sanitized error codes. Tests check hidden entry and piped-input refusal. |
| Plaintext buyer/mint secrets | Replaced with fixed-parameter scrypt + AES-256-GCM encrypted seed files, outside the repository, restrictive permissions and authenticated metadata. |
| Published keys/RPC token | All removed from the new tree. No old credential is reused. Git history remains public; only each credential's actual provider/account owner can revoke it. No provider revocation was performed. |
| Wallet overwrite and old leftover keys | Exclusive files, bounded manifest, duplicate detection, explicit selections, lock and fail-closed orphan detection. No reset/overwrite command. |
| Echoed private-key prompt | Removed. No seed/key import CLI. Hidden passphrase entry restores terminal settings and rejects noninteractive input. |
| Excessive max purchase cost | Old buy implementation removed. No executable purchase path exists. A new bounded, quoted buy integration remains to be implemented. |
| Zero minimum sell proceeds | Planner rejects zero/minimum-rounded-to-zero output, limits slippage and tips, and records externally supplied quotes as unverified. No unverified plan can be broadcast. |
| Missing developer/buyer signatures | Old consolidation removed; independent unsigned curve candidates retain each actual owner role. External funding-signature verification rejects missing, extra or invalid signatures and checks actual Ed25519 signatures. Unverified curve signing is blocked. |
| Random transaction fee payer | Removed. Funding uses explicit payer; each independent offline sell uses its owner. |
| Unsafe old Raydium route/Flash | Removed, with no reachable fallback. PumpSwap/migration integration remains blocked. |
| Wrong pool/curve/mint | Offline builder validates expected owner/mint/PDA, route and selected amounts. These caller-provided states are not certified on-chain data; production state acquisition is a blocker. |
| Unconfirmed settlement treated as success | Read-only reconciliation distinguishes finalized/failed/unknown; timeout never auto-resubmits. No submission path exists. |
| Oversized transactions/bundles | Offline compiler throws above 1,232 bytes; selection bounded at five. No unchecked SDK bundle-limit override or lookup-table execution remains. |
| Floating-point raw amounts | All asset quantities and percentages use raw decimal strings, bigint and basis points; malformed/overflowing raw values rejected. |
| Unrestricted network clients | Only an exact HTTPS public devnet endpoint is allowed; allowed methods and parameters are schema-checked. Redirects, credential URLs, wrong genesis, oversized responses, arbitrary methods and opaque transaction payloads are rejected. |
| Dependency advisories and install scripts | Tree reduced from 619 entries to 47, one exact direct dependency. New archives integrity-checked and screened; no installation hooks. npm reports zero current advisories. |
| Missing checks/CI | Adversarial tests, static policy scan, exact dependency lock and read-only pinned-action CI added. No deploy job or credential persistence. |
| Metadata image publication/privacy | Old uploader removed; no metadata/image publication from this preview. Future uploader must validate content, strip image metadata and expose intended publication. |

## Verification evidence

- `npm ci --ignore-scripts` installs the reviewed locked dependency set without lifecycle scripts.
- `npm test`: 52 behavioral/adversarial tests cover startup access, amount parsing, plan tampering/expiry, selection, encrypted storage, passwords/ciphertext/metadata/KDF tampering, permissions/symlinks/orphans/locks/directory replacement, bounded nonblocking reads, terminal privacy, exact-message single-use approval, signer completeness and cryptographic verification, verified blockhash contexts, input mutation during asynchronous work, endpoint/cluster/method/parameter restrictions, response bounds and failed/unknown/finalized settlement. The complete devnet genesis pin was checked against the public RPC's `getGenesisHash` response.
- `npm run check`: static repository/dependency policy checks pass. This is a limited deterministic regression screen, not a general malware detector.
- `npm audit --json`: zero info/low/moderate/high/critical advisories at audit time.
- All 47 new dependency archive records retrieved and matched their lockfile integrity; 1,400 JS/TS/JSON/shell text file entries screened, zero oversize exclusions, zero lifecycle declarations. Two network/key-word co-occurrences are in kit's browser bundles, which combine legitimate RPC and cryptographic implementations. Targeted inspection found no configuration-copy/exfiltration payload or startup network behavior. Node resolves the kit node ESM entrypoint.
- Manual review of every new application module, dependency declarations, CLI boundaries, private file operations, error handling, transaction signer roles and fail-closed paths.

No original application code or original dependency installation script was run. Disposable generated keys were used only in isolated local tests. No real wallet key, private RPC token or funded wallet was loaded. No transaction was broadcast and no exfiltration endpoint was contacted. GitHub CI status, if not yet completed, must not be confused with these local checks.

## Remaining risk boundaries and release blockers

1. **Functional integration:** live create/buy/sell/Jito/PumpSwap, external wallet signing, account/quote authenticity, exact-byte review/sign/submit binding, simulation and settlement/recovery must be implemented and integration-tested before trading is enabled. The preview deliberately contains no bypass switch.
2. **On-disk encryption is not machine security:** malware/root/same-user compromise, a malicious runtime/dependency/source edit or an unlocked signing process can defeat it. JS passphrase strings and WebCrypto key memory cannot be guaranteed erased. Use an isolated unprivileged account and an external treasury signer in a future release.
3. **Historical secrets:** removing them from a branch cannot undo publication. Never use the old auth/mint/RPC credentials. Provider-side revocation is outside this code change.
4. **Backups and crashes:** preserve encrypted files plus manifest and keep passphrase separately. A crash between wallet creation and manifest replacement can leave an orphan; selection then refuses operation. Recovery is manual and should start with an offline copy. No automatic key deletion or stale-lock takeover exists.
5. **Dependencies and platform:** archive integrity and zero advisories do not prove absence of all vulnerabilities. Future upgrades need review; OS/Node/provider security is outside this source audit. CI actions are commit-pinned but their external runner/platform is still trusted.
6. **Public blockchain information:** addresses, balances and completed public transactions are not private. The only enabled network use is schema-checked public devnet reads; no user data is submitted beyond those public request parameters.

## Required next acceptance gate

A reviewer must confirm the current official protocol interface and a complete disposable-key integration test must pass before introducing submission. That gate must show final decoded instructions/recipients, expected signer set, exact approved message bytes, authenticated fresh quotes/accounts, maximum total debit including rent/fees/tips, positive minimum proceeds, correct cluster, expiry handling and verified settlement. A self-supplied plan hash alone is insufficient authorization for a future executor.

## Second remediation pass (historical; superseded by the third pass below)

The first preview's checks were not a claim that all defects had been eliminated. A follow-up source review found and corrected these additional gaps:

| Gap | Correction and regression coverage |
|---|---|
| Generic signing accepted raw caller-supplied messages without a review capability | Removed public `signComplete`. Only immutable reviews issued by the approved builder can sign; exact message bytes, lifetime, plan and signer set are bound into the approval. Reconstructed JSON and hashes cannot forge an issued review. |
| A claimed `devnet` label did not prove the supplied blockhash came from devnet | Funding signing now requires a fresh in-process context issued by the restricted RPC client after cluster verification. Arbitrary/reconstructed contexts are rejected. This does not defend against a compromised RPC, runtime or malicious code already inside the signer process. |
| Concurrent signing could reuse approval | Single-use authorization is consumed before the first signing await. Parallel/replayed attempts are rejected. Expiry is rechecked during signing. |
| RPC parameters and curve/lifetime inputs could change after validation across awaits | Immutable snapshots are taken before asynchronous work; mutation regression tests verify original data is retained. |
| A GCM authentication failure could leave an unreferenced partial plaintext buffer | Partial plaintext is captured and wiped in `finally`, along with derived keys and assembled seed, including failed-authentication paths. |
| `create` checked less existing-vault state than `list` | Both now use the same complete inventory validation under the lock. Orphans, malformed payloads/manifests, unexpected files and duplicates stop writes. |
| Vault directory replacement/permission changes after construction were not pinned | Directory identity and permissions are rechecked; public root reassignment is removed. Lock cleanup checks identity, and wallet/manifest directory updates are fsynced. These checks do not remove the documented same-user/root threat boundary. |
| Opening a FIFO could block before file type validation; growing files could bypass a stat-only size bound | Shared nonblocking no-follow regular-file reads enforce an actual byte limit and strict UTF-8, with private permissions/hard-link checks for vault files. |
| Unverified curve quotes could still reach the offline signing helper | All curve reviews are now explicitly signing-ineligible. Only the restricted funding path has a signing capability; broadcasting remains unavailable for every path. |
| Settlement could return a different caller-mutated signature list, or accept malformed status data | Signatures/results are immutable snapshots, finalized status requires explicit error/status fields, non-null errors fail, and polling has a monotonic default clock plus an absolute poll-count bound. |

No runtime dependency was added or changed during this pass. Published credentials in old history remain unusable; provider-side revocation still belongs to their actual account owner. No private key or funded wallet was used, and no on-chain write was performed.


## Third remediation pass — external signatures and enforced funding budgets

The four gaps from the follow-up control audit are addressed as follows:

| Finding | Current correction |
|---|---|
| Unlocked key handles could bypass the application approval wrapper | Removed `Vault.unlock` and all application local-signing functions/imports. Password authentication returns public metadata only. The application can verify externally generated signatures but cannot create them through its API. A hardware/Phantom adapter is still not implemented. |
| Injected mock RPC could issue a supposedly production context | Context records distinguish native transport from injected transport. Production funding approval rejects every injected transport context, even if its genesis/blockhash responses look correct. Offline reviews have a separate non-production label. |
| Fee reserve was metadata rather than an enforced budget | Production review obtains `getFeeForMessage` for the exact compiled message plus the payer balance, checks transfer plus fee against the total-debit limit, and rejects any balance that would leave less than the reserve. Null, malformed or unavailable fee/balance responses fail closed. |
| A vault could be placed below an unsafe shared directory | Reject ancestors that are symlinks, owned by an untrusted UID or group/world writable without a root-owned sticky-directory exception. Repeat validation during operations; reject before creating a vault beneath an unsafe ancestor. |

The suite now has 52 tests, including external signature integrity, caller mutation during verification, forged/replayed signatures, production rejection of mock transports, debit/fee/reserve arithmetic, writable-ancestor refusal and permissions changing after construction. No dependency was added.

This removes application signing capabilities rather than claiming that software wrappers isolate a key from malware in the same process. The vault utility still transiently handles seed/password material for creation and authentication; compromised runtime/root/same-user code remains outside its protection. Real funds must use a separately trusted external wallet, whose actual integration remains a release blocker. Production funding review is read-only and cannot broadcast. Its budget evidence is only valid at review time and must be refreshed by any future executor.

The previous passes are retained as history, not descriptions of an available local-signing API. There is no promise of zero risk or a complete token creation/trading implementation. No real keys, funded wallets, deployment changes or on-chain writes were used.

## Lifecycle continuation — 2026-11-03

Added native SOL collection plans and independent System Program transaction construction.
Every selected source must sign its own transfer and pay its own network fee. There
is exactly one explicit destination, no consolidation payer, no Jito tip and no
implicit maximum-balance sweep. Production review reads exact-message fees and
balances using the bound devnet context, checks every source retains 0.01 SOL, and
caps aggregate transfers plus fees at 1 SOL. Review expiry, signer verification,
byte matching, single-use consumption and broadcast restrictions also cover collections.
Amounts must be chosen after sales settle; plans do not assert that a sale occurred.
This does not close token accounts, unwrap WSOL, or collect creator fees.

Protocol inventory: official pump-fun/pump-public-docs commit
639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22. PROTOCOL_INTERFACES.json records the
hashes of the retrieved IDLs and creation/trade account/argument schemas. This is
an interface inventory, not an audit of the on-chain program or deployment match.
Pump's current IDL contains create/create_v2, legacy buy/sell, and newer v2 trade
interfaces. PumpSwap has its own distinct trade accounts. The existing offline
sell candidate is not a complete implementation of these lifecycle paths.

Release blockers remain: current protocol adapters with account owner/PDA and
mint-extension validation; authenticated live quotes and dynamic fees; creation
and metadata upload; buy execution; PumpSwap migration detection and trading;
external wallet integration; simulation and controlled submission; persistent
transaction reconciliation; WSOL/rent handling; and a disposable-wallet devnet
creation→buy→sell→collection integration run. No end-to-end on-chain lifecycle
has been executed. Passing local tests does not remove these release blockers.
