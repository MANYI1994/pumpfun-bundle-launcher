# Pumpfun launcher — security rebuild preview

**This branch is a restricted development preview, not a usable live token launcher.** The original startup dependency steals configuration files. Its execution layer has been removed. Do not run the old `main` checkout or import valuable wallets into either version.

This replacement currently supports encrypted operational-wallet creation/listing, strict funding/sell plan review, offline transaction construction/signature verification tests, and read-only devnet status reconciliation. **Token creation, buying, network submission, Jito bundles, PumpSwap/Raydium execution and Flash are unavailable.** No environment variable enables them. The bonding-curve builder is an offline candidate, not a certified adapter to the currently deployed program.

## Requirements and installation

Use Linux, a supported Node 24 release and a dedicated unprivileged operating-system account. Do not run a wallet application as root. Keep the OS and Node security patches current. No application should be trusted on a machine with malware or a compromised user account.

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run audit:dependencies
npm start -- help
```

There is one direct dependency, `@solana/kit@8.6.0`, and 47 locked entries. The lockfile is required. Installation scripts are disabled. Do not use a forced dependency update or restore packages from the old lockfile.

## Wallets

The default vault lives outside this repository at `~/.local/share/pumpfun-launcher-v2`. Set `LAUNCHER_VAULT_DIR` only to choose a different absolute private directory outside the repository. It is a path, not a password. The CLI never accepts a seed, private key or passphrase in command-line flags or environment variables.

```sh
npm start -- wallet create buyer-one buyer
npm start -- wallet list
```

Creation requires a real interactive terminal and asks twice for a hidden passphrase of at least 16 characters. Use a password-manager-generated random passphrase. The CLI prints only public wallet identifiers and addresses. All operational roles use the same encrypted format; there is no main treasury key import.

Private seeds are encrypted using AES-256-GCM with fresh random salt/nonce and scrypt parameters fixed in code (`N=32768, r=8, p=1`). Wallet metadata is authenticated. Owner-only file/directory permissions, bounded nonblocking no-follow reads, exclusive creation, a fully checked manifest and a lock prevent common accidental exposures and overwrites. Root directory identity/permissions are rechecked for operations; unexpected recovery files stop the operation. Both decrypted seed buffers and unauthenticated partial plaintext are cleared, including after authentication failure. Transient WebCrypto keys are used for address validation; none are returned by the vault API. JavaScript strings and the runtime's internal key objects cannot be guaranteed to be wiped; encryption does not defeat malware running as your user while the vault is unlocked.

Back up the **entire encrypted vault directory including its manifest**, while no command is running, to an offline location. Keep its passphrase separately. There is intentionally no overwrite/delete/reset command. A stale `.lock` or orphan `.vault` after a crash fails closed: preserve a copy first and inspect/recover state manually; do not delete keys or blindly clear locks. A lost passphrase has no recovery back door. Do not put funds into this preview's wallets.

## Review-only funding plan

Create an input JSON containing `payerAddress` and an explicit `wallets` array; each row has `id`, `address`, and `lamports` as a decimal string. A plan is capped at five recipients and one SOL including the quoted transaction fee, while retaining an enforced fee reserve. Only zero tips are supported. These are defensive limits for test inputs, not a mainnet funding feature.

```sh
npm start -- plan fund input.json new-plan.json
npm start -- inspect plan new-plan.json
```

Output files are created exclusively with owner-only permissions and cannot overwrite an existing file. Plans expire after sixty seconds. Review the exact addresses/amounts and digest. Hashes detect changed plans; they are not an oracle or proof that an external quote is correct.

## Review-only sell plan

Input fields: `mint`, `percent` as a string such as `"10"`, `slippageBps` (1–300), zero `tipLamports`, and an explicit `wallets` array. Each wallet row contains `id`, `address`, `balanceRaw`, and `quotedOutputLamports`; the quote must refer to that wallet's computed sale amount. These externally supplied quotes are **unverified**, clearly marked as such, and cannot be broadcast.

The new design computes the chosen percentage of each selected wallet's holdings using bigint arithmetic. The offline candidate sells independently from each selected wallet and keeps proceeds in that wallet. This deliberately differs from the unsafe original's consolidation into a payer. A developer wallet is included only if explicitly selected. It does not randomly choose a fee payer, assume six decimals or allow a zero minimum return.

```sh
npm start -- plan sell input.json new-sell-plan.json
```

Unknown/migrated routes are rejected. No hard-coded 25% rule is presented as actual price-impact protection. Real execution needs authenticated fresh account state, a tested quote adapter and enforced settlement, not just a percentage rule.

## External-signature boundary

The application does not sign transactions. `Vault.unlock` and `signReviewedBatch` have been removed. `verifyPassword` returns public authentication metadata only, never a key or signer. `verifyReviewedBatch` verifies signatures supplied by an external wallet against the exact reviewed message, required addresses, expiry and single-use approval. Changed bytes, missing/extra/invalid signatures and replay are rejected. Its output is immutable public wire data and always has `broadcast: false`.

Production funding review requires a native-transport devnet context. Explicitly injected test transports can still exercise read-only behavior, but their contexts cannot authorize production review. Offline reviews are separately labeled `productionVerified: false` and cannot become production approvals.

Before issuing a production funding review, the client fetches the fee for the exact message and the payer balance. The transfer plus fee must fit within the one-SOL maximum debit and leave the fixed reserve intact. This is a review-time check; a future executor must check fresh conditions again before submitting.

Vault paths must have trusted, non-writable ancestors owned by the current user or root. Root-owned sticky ancestors such as `/tmp` are allowed, but vault roots remain owner-only. These checks are repeated during operations. The vault remains a local creation/authentication utility, not a hardware-isolated signer: malicious code in that utility could still observe passwords/seeds while they are being handled. Do not fund preview wallets. A Phantom/hardware integration is not implemented yet.

Curve reviews remain unsigned and cannot be accepted by the external-verification path because their quotes/state are unverified. Already-produced signatures are not revoked by a review timeout. Broadcasting remains unimplemented.

## What remains before any live use

- Implement and integration-test current official token creation/buy/sell and PumpSwap routing; verify current program layouts, accounts, fees, mint authority outcomes and output destinations.
- Implement a main-wallet external signer (Phantom/hardware), explicit spend approval and a separate limited operational signer boundary.
- Add fresh on-chain balances/quotes, simulation, final decoded transaction review and exact-byte approval through the complete signing-to-submission flow.
- Test transaction/bundle size, fees, compute limits, blockhash expiry, all required signatures, failed/partial/unknown settlement and restart recovery with disposable keys on a supported test environment.
- Only then add a separately reviewed submission implementation. Do not replace the current `Rpc.send()` refusal with raw `fetch` or copy the old execution files back.

See [SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) for the final review scope and remaining blockers. This preview fixes/removes unsafe code paths; it is not functional parity with the old launcher and is not certified risk-free.
