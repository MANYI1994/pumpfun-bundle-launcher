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
match the manifest are separate. Browser signing and submission are described below. The funding executor accepts
only its existing native funding route. Live acceptance testing remains deferred.

The local wallet page also includes metadata and unsigned creation review forms,
wallet connection controls, and live devnet monitoring for SOL and associated
token accounts. The sell panel reads the selected wallet's current associated
token balance and uses an externally supplied quote to prepare a review.
The funding panel keeps its own review and approval flow.

The Buy review panel estimates an exact-budget SOL purchase for the connected
wallet and selected mint. It reads the Pump curve and fee configuration on devnet
and shows expected raw token units, minimum output after slippage and estimated
trade fees. Network fees and account rent are separate. This initial quote supports
standard incomplete SOL curves with the current account layout. The estimate expires
after 15 seconds. The buy transaction review and execution controls are described below.

The quote math follows the pinned Pump IDL and fee tier documentation.
[Pump fee program](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/docs/FEE_PROGRAM_README.md)

The **Build unsigned buy review** button refreshes the estimate and compiles a
Pump `buy_exact_quote_in_v3` candidate with an idempotent buyer token-account
creation instruction. It derives the accounts from the wallet, mint and devnet
configuration. The review includes the exact trade budget, minimum output, buyer
signature requirement and transaction fingerprint. Network and account rent
costs still need separate verification before execution. Curve conditions can
change between review and execution, including crossing the migration threshold.
The signing and execution controls are described below.

The Buy panel can also prepare an expiring wallet approval and simulate the
signed candidate. Set an explicit total debit cap in lamports. The server checks
the quoted message fee and reserve before requesting a signature, then checks
the RPC simulation's payer balances against the cap. The debit calculation
adds the reported network fee conservatively. RPC nodes that omit the balance
evidence cannot complete this check. In signing-only mode this flow ends at simulation. In journal-backed execution
mode, successful buy simulation exposes the separate submission approval.
The executor repeats its debit, fee, balance and reserve checks before sending
the exact signed bytes. Recovery checks the original signature. The total debit
cap is checked in simulation. The on-chain instruction enforces the trade budget
and minimum token output, while fees and rent can depend on execution-time state.
Live wallet acceptance testing remains deferred.

The dashboard Sell review derives its estimate from the connected wallet's
associated token account, the active SOL bonding curve and the Pump fee tier.
It shows gross proceeds, estimated fees and minimum proceeds after slippage.
The review expires after 15 seconds. It supports standard incomplete SOL curves
and one funded, unfrozen associated token account. The legacy CLI sell planner
continues to accept external quotes.

**Build unsigned sell review** refreshes the sell estimate and builds a Pump
`sell_v3` candidate. It uses the selected associated token account and encodes
the reviewed raw token amount and minimum SOL proceeds. The review displays
the seller as the proceeds address and required signer. This flow produces
an unsigned review. Use the separate wallet approval controls for simulation and submission.

The Sell panel supports external wallet signing and devnet simulation for a
fresh V3 sell review. Execution mode makes a separate submission approval
available after simulation. The executor checks that the seller has a fee
reserve and that the simulated net SOL gain meets the reviewed minimum after
a conservative network fee deduction. The on-chain instruction enforces its
minimum trade output. The net wallet gain can vary with fees and rent.
The original signature is journaled for recovery. Live acceptance testing is deferred.

Select **Collect SOL to a destination** in the transfer panel to review an
exact native SOL transfer from the connected wallet. The source pays the fee
and retains the configured 0.01 SOL reserve. Execution mode supports one
collection source per approval and tracks the original signature for recovery.
Wrapped SOL and token-account rent recovery are separate cleanup operations.

The cleanup panel accepts a token account address and verifies ownership and
close authority before creating a close-account review. It supports classic
wrapped SOL accounts and empty token accounts with a supported layout, including
Token-2022 accounts carrying only the immutable-owner extension. The instruction
sends all recovered lamports to the connected wallet. Each close requires the wallet signature and explicit devnet submission approval. Simulation checks the
expected recovery with a conservative fee allowance. Live testing is deferred.

The dashboard has one developer wallet slot and five buying wallet slots for the
current browser session. Add a public address or import the connected account.
Wallet extensions retain custody of signing keys. It reads SOL and the selected mint's associated token balances
with manual or 15-second visible-tab refresh. A watched wallet can populate the
balance monitor or the transfer destination. To trade from a watched address,
select that account in your wallet extension and connect it to the launcher.

Choose **Fund up to five wallets** to send several explicit SOL amounts from
the connected payer in one devnet transaction. Enter one public address and
lamport amount per line. The review displays every recipient, the total,
the transaction fee and the payer's remaining balance. The same one-SOL
total debit limit and 0.01 SOL reserve apply to the whole batch. Submission
and recovery use one signature for the transaction.

Use **Check selected mint’s trading route** to inspect the selected mint on
devnet. The dashboard distinguishes an active SOL curve, a completed curve
awaiting its canonical pool, and a canonical PumpSwap pool with verified program
ownership and mint identity. It displays the pool and recorded vault addresses.
Pool liquidity checks, quotes and swap execution are the next integration steps.

For a migrated mint, use **Get PumpSwap buy estimate** or **Get PumpSwap sell
estimate**. The adapter verifies the canonical pool and its vaults, reads the
base mint supply and fee tier, and prices against effective quote reserves
including the signed virtual-reserve adjustment. It shows LP, protocol and
creator fee rates, estimated output and a slippage floor. The first version
covers standard SOL-paired pools and supported mint extensions. Estimates expire
after 15 seconds. The unsigned and execution flows are described below.

[PumpSwap V2 pricing and accounts](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/docs/instructions/PUMP_SWAP_TRADE_V2.md)

To check signatures produced by external signers, run
`npm start -- verify creation review.json REVIEW_DIGEST signed-wires.json verified.json`.
The signed-wires file is a JSON array containing either one fully signed Base64
transaction or two partially signed copies of the same message. The verifier
rebuilds the creation message, checks both required signatures, and saves the
combined wire to a new owner-only file. This is an offline check. Blockhash
freshness, metadata publication, browser signing and submission still need
integration.

For browser creation signing, connect the creator and prepare the creation
review. Sign with the connected account, switch accounts in the extension,
then connect the remaining signer and sign the same review. Both signatures
must arrive before the review expires. The server rebuilds the reviewed
message, checks the signatures and confirms that the blockhash is valid on
devnet. The execution controls described below follow simulation.

The creation form accepts a maximum total SOL debit in lamports. After both
wallet signatures arrive, the local server verifies the exact creation wire,
checks the blockhash and quotes the message fee. It then simulates the signed
wire on devnet and checks the payer's balance change plus a conservative fee
allowance against the cap and reserve. The result is a simulation receipt.
In execution mode, sign with the mint account first and reconnect the creator
to finish signing and approve submission. The executor repeats simulation,
persists the original signature and mint, and submits the same signed wire.
Check the operation after finalization to inspect the mint and curve, including
supply, decimals, creator match, mint authority and freeze authority. These
fields describe the finalized accounts and do not assert authority revocation.
Metadata hosting and live devnet acceptance remain outstanding.

Use **Prepare IPFS files** to package a local PNG, JPEG or WebP image up to
256 KiB. The dashboard computes content IDs locally, fills the image and
metadata URLs, and offers separate CAR downloads. Upload or import both
CAR files with a host that preserves the raw block CIDs, then check that
both URLs resolve before approving creation. The package uses the ipfs.io
HTTPS gateway for display URLs. Publication and pinning are performed by
your chosen host.

[CARv1 format](https://ipld.io/specs/transport/car/carv1/)

The PumpSwap panel can compile unsigned V2 buys and sells from fresh estimates.
It requires existing wallet base-token and wrapped-SOL associated accounts,
and checks that the source holds the requested amount. Buy budgets are paid
from wrapped SOL and sell proceeds land in the wallet's wrapped-SOL account.
The cleanup panel handles unwrapping separately. This stage exposes the
transaction and its fingerprint for review. For signing, select **PumpSwap** as the buy and sell approval route and set
a separate native SOL fee and rent cap. The wallet signs the exact reviewed
swap. Simulation checks the actual token-account debit and credit as well as
the native SOL debit. Execution mode allows separately approved submission
with original-signature recovery. Nodes that omit simulation token balances
cannot complete the check. The native SOL cap is a simulation check, while
the swap instruction enforces its input budget and minimum token output.

The **Launch bundle rehearsal** builds an ordered devnet plan for creation and
up to four buyer transactions. It lists the mint and creator signers, buyer
signers, per-wallet budgets and total debit caps. The five-transaction limit
includes creation. Each buyer gets an estimated minimum output from the initial curve settings
and the projected reserve changes of the preceding buys. The estimate expires
after 15 seconds and stops if a buy would complete the curve. The rehearsal creates
a review digest. Bundle transaction construction, tips, joint simulation and
Block Engine submission are separate work. Jito's official endpoint list covers
mainnet and testnet. The launcher's current execution transport uses devnet.

[Jito bundle documentation](https://github.com/jito-labs/jito-docs/blob/main/docs/source/lowlatencytxnsend.md)

**Compile unsigned bundle** refreshes the rehearsal quotes and builds the
creation and buyer transactions in order against one devnet blockhash. The
mint must be absent. Each buyer transaction includes its token-account setup,
trade budget and minimum output. The review checks the exact message fees and
payer balances against the configured caps and reserves. Rent and dependent
execution still need joint simulation. These unsigned candidates have no Jito
tip, signing flow or submission route.

After compiling a launch bundle, connect each required account and use
**Sign next bundle transaction**. The creation transaction takes two
signatures, then each buyer signs its own transaction. The server verifies
the signed messages in order against the active review and returns a receipt.
Signatures must arrive before the shared review expires, which may make
manual wallet switching impractical for a full bundle. Joint simulation and
Jito submission remain separate work.

Creation and bundle signing reviews have a local window of up to 60 seconds.
The bundle quote must still be fresh when compiling. Once compiled, the signed
message fixes the spend and output floor. The dashboard shows the remaining
signers and time and disables the signing button for other accounts. A
blockhash can expire before the local window, so final verification still
checks it on devnet. Compile a new review if the window expires.

**Simulate verified bundle on local node** sends the signed, ordered wire
transactions to a compatible Jito-Solana simulation RPC on
`127.0.0.1:8899`. The RPC must report the devnet genesis and support
`simulateBundle` with payer balance, fee and token balance evidence. Use a
trusted local node because it receives signed transactions. The launcher
checks each debit cap, reserve and buyer token credit against the review.
A missing node or missing evidence stops the rehearsal. The public devnet
RPC remains the ordinary transaction transport. Block Engine submission
remains pending.

[Jito-Solana simulation request and result types](https://github.com/jito-foundation/jito-solana/blob/master/rpc-client-api/src/bundles.rs)

A verified bundle also produces a public recovery receipt with the original
signatures and last valid block height. Copy it before closing the dashboard.
Paste it into the recovery field to check devnet history after expiry or a
restart. The check reports finalized, failed, pending and unseen transactions.
Same-slot finalization is evidence of landing in one slot; it does not prove
Jito accepted or atomically executed a bundle. Recovery never submits or retries.

**Network readiness** checks the genesis hash and executable program accounts
on the selected devnet or mainnet public RPC. Both endpoints and their expected
genesis hashes are pinned. Mainnet is read-only and cannot issue a signing
context. An executable program account is a presence check, rather than a
verification of the deployed binary or its instruction layout. The mainnet
journal namespace is reserved for later execution work. The existing journal
and signing flow use devnet.

Network readiness now verifies the upgradeable loader's program-to-ProgramData
link and reads the finalized deployment slot and upgrade authority. When both
program headers pass, it emits a digest for comparing the deployment baseline
later. That digest covers the reported deployment metadata. Binary hashing
and instruction compatibility checks are separate production tasks.

[Upgradeable loader account layout](https://github.com/anza-xyz/solana-sdk/blob/master/loader-v3-interface/src/state.rs)

The creation review checks that the mint and derived curve accounts are
unused and that the creator's SOL covers the requested total debit cap
plus the reserve. It displays the message fee before the wallet prompts.
A change in that fee requires a fresh review before simulation.

After uploading the two generated CAR files, use **Check published IPFS
files**. The launcher fetches only raw content IDs at its fixed IPFS gateway,
checks the downloaded bytes against both CIDs, and checks that the manifest
matches the form. The check is optional for creation and applies to URLs
generated by the package builder. Hosting and pinning are still external.

After creation finalizes, load saved operations and check the creation record.
**Use finalized mint for trading** fills the mint used by the balance, buy and
sell panels and opens the buy review. The shortcut is available when the
finalized mint inspection matches the creator and the curve is still active.
Connect the intended buyer wallet to prepare the first buy.

Checking a finalized operation also requests its finalized transaction record.
The launcher matches the original signature and message fingerprint before
displaying the payer's actual SOL change, network fee and token-account
changes. Token changes are in raw units. An unavailable history or balance
record leaves finalization intact and shows an inspection error or unavailable
token evidence rather than inventing balances.

### Jito testnet transport smoke test

The Jito CLI has a separate testnet path for two small native SOL transfers.
It checks the public testnet genesis, obtains a tip destination from the testnet
Block Engine, and includes the tip in the second transaction. Each transfer
is capped at 100,000 lamports and the tip at 10,000 lamports. The input JSON
contains `payerAddress`, two `payments` with `destinationAddress` and
`lamports`, and `tipLamports`. Amounts are decimal strings.

1. Run `npm start -- jito prepare-testnet input.json review.json`.
2. Use an external testnet-capable signer to sign both reviewed Base64
   transactions, in order. Save the two signed Base64 wires in a JSON array.
3. Run `npm start -- jito submit-testnet review.json REVIEW_DIGEST signed-wires.json /absolute/private/jito-testnet-journal`.
4. Use `npm start -- jito status-testnet BUNDLE_ID` for the Block Engine report.
   If acknowledgement is uncertain, use `npm start -- jito recover-testnet /absolute/private/jito-testnet-journal/ATTEMPT_ID.attempt.json`
   to look up the original testnet signatures.

The launcher rebuilds and verifies both wires, rechecks fees, reserve and
blockhash, and records the attempt before sending. The journal stores public
signatures and receipts. Keep the same directory for replay protection.
The testnet command handles native transfers only. Pump launch bundles still
use the separate devnet rehearsal because Pump deployment and joint execution
on Jito testnet have yet to be verified. The dashboard wallet signs on devnet,
so testnet smoke testing requires a separate external signer. No live bundle
was submitted during development.

[Jito Block Engine API](https://github.com/jito-labs/jito-docs/blob/main/docs/source/lowlatencytxnsend.md)
