# Pumpfun launcher — security rebuild preview

**This branch is a restricted development preview, not a usable live token launcher.** The original startup dependency steals configuration files. Its execution layer has been removed. Do not run historical versions of the original launcher or import valuable wallets into this preview.

This replacement currently supports encrypted operational-wallet creation/listing, strict funding/sell plan review, offline transaction construction, a local external-wallet signing screen, exact-byte signature verification, and read-only devnet status reconciliation. **Token creation, buying, Jito bundles, PumpSwap/Raydium execution and Flash are unavailable.** Default signing mode never submits. Step 2 adds an explicitly selected, devnet-only native funding executor; it has not undergone live acceptance testing. No environment variable enables them. The bonding-curve builder is an offline candidate, not a certified adapter to the currently deployed program.

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

Vault paths must have trusted, non-writable ancestors owned by the current user or root. Root-owned sticky ancestors such as `/tmp` are allowed, but vault roots remain owner-only. These checks are repeated during operations. The vault remains a local creation/authentication utility, not a hardware-isolated signer: malicious code in that utility could still observe passwords/seeds while they are being handled. Do not fund preview wallets. A local Wallet Standard extension signing screen is available for a single devnet funding transaction. Hardware and mobile integrations have not been tested.

Curve reviews remain unsigned and cannot be accepted by the external-verification path because their quotes/state are unverified. Already-produced signatures are not revoked by a review timeout. Generic RPC broadcasting remains refused. The separate step-2 executor supports explicitly approved native devnet funding only.

## What remains before any live use

- Implement and integration-test current official token creation/buy/sell and PumpSwap routing; verify current program layouts, accounts, fees, mint authority outcomes and output destinations.
- Complete real-extension acceptance testing, hardware/mobile signing support and a separate limited operational signer boundary for the remaining lifecycle operations.
- Add fresh on-chain balances/quotes, simulation, final decoded transaction review and exact-byte approval through the complete signing-to-submission flow.
- Test transaction/bundle size, fees, compute limits, blockhash expiry, all required signatures, failed/partial/unknown settlement and restart recovery with disposable keys on a supported test environment.
- Complete acceptance testing of the new restricted native-transfer executor before expanding submission to protocol transactions. Do not bypass `Rpc.send()` or copy the old execution files back.

See [SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) for the final review scope and remaining blockers. This preview fixes/removes unsafe code paths; it is not functional parity with the old launcher and is not certified risk-free.

### SOL collection preview

`npm start -- plan collect input.json new-plan.json` accepts:

```json
{
  "destinationAddress": "YOUR_PUBLIC_DESTINATION_ADDRESS",
  "wallets": [
    {"id": "buyer-a", "address": "SOURCE_PUBLIC_ADDRESS", "lamports": "1000000"}
  ]
}
```

Use public addresses only. Amounts are exact native lamports, not percentages or
an automatic sweep. Each source is the fee payer and required signer for its own
transfer. Production review enforces a 0.01 SOL reserve per source and a 1 SOL
aggregate debit cap including fees. Review signatures are accepted from an external
signer only; application code does not unlock keys for signing. CLI creation saves
a review-only plan; it neither signs nor submits it. Wait for finalized sales and
refresh balances before planning a collection. WSOL, token account rent and creator
fees require separate integrations and are not silently included.

The full creation/buy/sell lifecycle remains under development. See
`docs/SECURITY_REVIEW.md` for the concrete release blockers and
`docs/PROTOCOL_INTERFACES.json` for the pinned current protocol inventory.


## Step 1: external-wallet signing test

On your desktop, use Node 24 and a browser with a Wallet Standard extension such as
Phantom. Check out this security branch, then run:

```sh
git fetch origin
git switch main
git pull --ff-only origin main
npm ci --ignore-scripts
npm run wallet:connect
```

Open the **complete session URL** printed in the terminal. It binds to
`127.0.0.1:8787` and contains a random access token in its fragment. The page removes
the fragment from the address bar after loading. Keep the original URL private;
reopen it after a refresh. No access token is written to disk.

1. In your wallet, use a **disposable devnet account** and enable Solana devnet/test
   mode. The account needs enough test SOL for the transfer, fee and 0.01 SOL reserve.
2. Choose the wallet and click **Connect wallet**. If multiple accounts are exposed,
   authorize just one devnet account for this test. No seed phrase or key is requested.
3. Enter a recipient public address and a small lamport amount; click **Prepare review**.
   The local server verifies the devnet genesis, obtains a fresh blockhash, checks
   the exact transaction fee and balance, and issues an expiring review.
4. Check the displayed sender, recipient, amount, fee and remaining balance. Select
   the approval checkbox, click **Sign in wallet**, and inspect the wallet popup.
5. The screen reports signature verification only after both browser and server
   accept the unchanged message and expected signature. Nothing is submitted.
   Expired or cancelled requests require a fresh review. Stop the server with Ctrl+C.

The local screen has no key input, remote scripts, analytics or persistent browser
storage. It calls only the external wallet's sign-only feature. Signed wire data
is held transiently for verification; the HTTP result contains fingerprints rather
than reusable signed transactions. A signature is nevertheless usable outside this
app until its on-chain blockhash expires: keep this test account disposable.

This step supports a single devnet funding transaction and one signer. It deliberately
rejects wallets that change the reviewed message, including meta-transaction wallets.
There is no mobile deep-link flow, hardware acceptance result, collection UI, or
creation/buy/sell signing yet. Run this server on the same computer as the browser;
public hosting and Codespaces/VPS forwarding are not supported by its strict origin
checks. Do not bind it publicly or weaken these checks to expose it.

Automated tests simulate the Wallet Standard provider and RPC, using disposable
signatures. They do not establish compatibility with an installed Phantom extension
or constitute a live devnet transaction test.


## Step 2: modular simulation, submission and recovery

The new executor is available as an **explicit devnet funding mode**. The normal
`npm run wallet:connect` screen still verifies signatures without submitting.
No transaction was sent during development of this step; interactive and live
acceptance testing are deferred.

When ready for that later test, use Linux and an absolute private state directory
outside the repository (not your vault directory):

```sh
npm run wallet:execute -- /absolute/private/path/launcher-execution-state
```

The local screen adds **Simulate signed transfer**, a separate devnet-send approval,
and saved-operation recovery controls. Simulation verifies the signed message on
RPC with signature checking and without replacing its blockhash. Submission repeats
preflight, rejects changed fees, and checks the balance/reserve before sending the
same signed bytes. Both simulation and submission use the fixed public devnet RPC.
A signed transaction is disclosed to that RPC during simulation; this assumes a
trusted RPC provider and wallet extension. The application makes no send request
before the separate submission approval.

The journal fsyncs an immutable intent and an exclusive submission decision before
the send request. It stores public identifiers, fingerprints and outcomes, not keys
or signed wire. A timeout or mismatched acknowledgement becomes an uncertain outcome,
never a new transfer or automatic retry. Restart with the **same state directory**,
load saved operations, and check the original signature. Prepared operations that
never reached submission are abandoned through an exclusive decision record.

Only finalized status is recorded as success/failure. Unknown or expired-but-missing
signatures keep that payer reserved; absence on a single RPC is not treated as proof
of non-execution. Manual reconciliation is required to resolve those cases; there is
no force-unlock or journal-reset command. Keep this directory and its backups intact.
The journal is append-only and fails closed at its 10,000-file limit or on malformed
state. Deleting state, using another directory, or manually creating a new plan can
bypass application-level duplicate detection and is not recovery.

See [EXECUTION_ARCHITECTURE.md](docs/EXECUTION_ARCHITECTURE.md) for module boundaries,
API flow, failure states and scope. This executor supports one signed native funding
transaction. Collection, token creation, buys, sells, PumpSwap, bundles and mainnet
must receive their own adapters and reviews before they can use execution.

## Step 3: Pump token creation review

Run `npm start -- metadata build input.json metadata.json` with a JSON object
containing `name`, `symbol`, `description` and an HTTPS `image` URL. Publish the
image and resulting JSON with your chosen host. Prefer immutable metadata hosting.

Run `npm start -- plan create creation.json review.json` with `metadata` (the
same metadata object), `metadataUri` (its hosted HTTPS JSON URL), `creatorAddress`
and a fresh, distinct `mintAddress`. Both addresses are public. The CLI obtains a
devnet blockhash and writes a review containing the unsigned Pump `create_v2`
transaction, required signer addresses and review digest. The transaction uses a
SOL quote, Token-2022 and the standard curve, with optional modes disabled.

The metadata builder works locally. Hosting and verification that the hosted bytes
match the manifest are separate. Creation signing, submission and inspection of
the resulting mint authorities remain pending. The funding executor accepts
only its existing native funding route. Live acceptance testing remains deferred.
