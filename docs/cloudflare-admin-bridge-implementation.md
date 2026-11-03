# PocketPal ↔ Cloudflare managers — implementation notes

Status: repository and live-Worker discovery complete; no production Worker or secret was changed.

## PocketPal repository findings

- The app is React Native 0.87.1 / TypeScript and already has a Talent engine registry.
- Built-in engines are registered in `src/services/talents/index.ts`; the Pal editor exposes registered engines through `src/components/PalsSheets/TalentSection.tsx`.
- `TalentEngine.execute(args, ctx?)` is the extension contract. Results are returned to the model as text, so the Cloudflare engine must return bounded, redacted summaries rather than secret-bearing payloads.
- `react-native-keychain` is already installed and used by `src/store/SearchProviderStore.ts`. A separate service namespace can store a PocketPal-to-gateway credential; upstream Cloudflare API tokens must never be stored in the app.
- Talent UI registration is separate from engine registration. The existing generic TalentSection can expose a new engine without a bespoke UI.
- This is a bare React Native project; there is no Expo/EAS configuration.

## Live Cloudflare accounts and Workers

Read-only inspection of both connected Cloudflare sessions confirmed:

- Manager 1 account: `443206d2fcb0e88cbe6ca6f5fa8c14e9`; Worker: `personal-ai-manager`.
- Manager 2 account: `28e81766ca187c00138b277cf502705b`; Workers include `goldstar-financial-v3`, `goldstar-trainer`, `trading-research-agent`, and `tv-ingest`.

## GOLDSTAR organization registry and access policy verified in L1 D1

The live L1 D1 database is `2f9551be-0c6c-4750-9279-ba6035d60d26`. Its schema includes the active organization/governance tables `gs_org_units`, `gs_org_agents`, `gs_org_tasks`, `gs_org_access_policies`, `gs_org_connections`, `gs_l1_policy`, `gs_l1_audit`, and `gs_l1_decisions`. The app's L1 read operations must use these tables, not the older generic `agents` and `tasks` tables.

Current registry facts:
- `GOLDSTAR_CORE` is the level-1 central unit; `GOLDSTAR_FINANCIAL` is the level-2 financial domain.
- The financial L2 agent is `L2`, status `defined`; the L1 manager agent is `L1`, status `defined`.
- Construction, manufacturing, and trade L2 managers are currently `planned`, not operational.
- The active `CORE_L1` policy allows task assignment/monitoring, reading domain reports, managing the organization registry, proposing policy changes, and halting unsafe operations. It denies reading secret values, executing live trades, approving its own high-risk actions, and bypassing domain controls.
- The active `DOMAIN_L2` policy limits L2 to its own domain. It denies access to other domains' private data, secret values, organization-policy changes, and unapproved trades.
- `OWNER_L0` is the human final authority for high-risk approvals.

The current `goldstar.core` policy explicitly sets `live_trading_enabled=false`, `initial_mode=demo`, `require_l1_approval=true`, `approval_payload_hash_required=true`, `approval_expiry_required=true`, `fail_closed=true`, `paid_services_allowed=false`, `automatic_billing_allowed=false`, `per_manager_separate_account=false`, and `logical_isolation_required=true`. PocketPal must preserve these controls; it must not invent extra authority for L1 or L2.

The live `CORE_FINANCIAL_BRIDGE` registry row remains `helper_defined_runtime_unverified`; its notes explicitly say the runtime bridge preview test is pending. A recent `last_verified_at` timestamp alone does not override that status. The separate L1 task `FIN-V1-001` (read-only bridge test) remains blocked, and `ORG-V1-003` (L1 registry/task-dispatch API) also remains blocked. Therefore, neither the L1→L2 bridge nor a PocketPal API is currently verified end-to-end.

## L2 read/write boundary verified in source

The current L2 source in `blacklight-star/goldstar-financial/src/worker.js` is version 3.0.1. Its read endpoints include `/health`, `/status`, `/training/progress`, `/training/pending`, `/training/sources`, `/knowledge/:style`, and `/strategy`. Its write endpoints include `/training/approve`, `/strategy/synthesize`, and `/training/batch`. `/analyze` is explicitly disabled until a verified market-data feed is connected and validated.

Do not expose `/knowledge/:style` to PocketPal: it returns the entire KV list and does not filter `validationStatus === "approved"`. Use `/status` and `/training/progress` for counts only; `/training/pending` is a separately labelled review queue. No approve, batch-ingest, strategy-synthesis, or analyze operation is included in v1.

## Critical deployment-state distinction

The Worker Scripts API returns the **latest uploaded source**, which is not necessarily the version receiving production traffic.

- Latest uploaded L1 version: version **60**, source declares `CONFIG.VERSION = 6.2.2`; it is annotated `bridge-test` and described as a preview candidate for owner-bound, expiring approval payloads, a five-minute reviewed-rule snapshot, payload/rule-set hashes, and a one-time request ID. It is explicitly **not deployed**.
- Version **59** is annotated `github-recovery-once`; version **58** is an earlier `bridge-test` candidate; version **57** is the organization-registry candidate.
- The actual L1 production deployment remains version **56** at **100% traffic**. Version 56's annotations say `Add secret: GOLDSTAR_FINANCIAL_BRIDGE_KEY`.
- L2 production remains version **19** at **100% traffic**; L2 version **20** is a preview candidate with a D1 binding and matching approval-envelope logic, not deployed.
- The current script-content endpoint returns the latest uploaded version 60, even when a version-56 query parameter is supplied. The version-specific GET endpoint exposes metadata/bindings, not the source code.

Therefore, the v6.2.2 source examined below is **not confirmed to be the production source**. Do not deploy, overwrite, or base a production patch on it until version 56's exact source has been recovered or otherwise verified. Cloudflare's existing version/deployment history remains intact.

## L1→L2 bridge evidence

The latest uploaded L1 source (v6.2.2; version 59) contains:

- `FINANCIAL_WORKER_URL = https://goldstar-financial-v3.goldstar-nsl83.workers.dev`
- `callFinancial(endpoint, env, method, body)`, which uses `GOLDSTAR_FINANCIAL_BRIDGE_KEY` (falling back to `GOLDSTAR_API_KEY`) and sends both `X-API-Key` and `X-Goldstar-Bridge-Key`.
- Telegram commands for financial status, health, training, pending review, approval, strategy, and knowledge.
- A diagnostic route `/__preview/financial-bridge`, restricted to host `bridge-test-personal-ai-manager.goldstar-al-manager.workers.dev`.

The deployed L1 version 56 metadata confirms secret bindings named `GOLDSTAR_API_KEY` and `GOLDSTAR_FINANCIAL_BRIDGE_KEY`, but its exact source and runtime bridge success have not yet been confirmed.

The current `goldstar-financial-v3` source in GitHub identifies itself as version 3.0.1. It accepts the dedicated `X-Goldstar-Bridge-Key` against Worker secret `L1_BRIDGE_KEY`, as well as the legacy `X-API-Key` against `API_KEY`. Its `/health` route is public; other routes require authentication.

Do not create a duplicate L1→L2 bridge or expose any existing bridge secret to the phone. The remaining work is to verify which bridge code is active in production and test it through a controlled preview before using it from PocketPal.

## Missing capability for PocketPal

The latest uploaded L1 v6.2.2 source (version 60) does not define a general PocketPal API. Its HTTP route list includes `/`, `/webhook`, `/setup`, `/github-test`, `/agent-report`, and internal/preview routes. The `/__preview/financial-bridge` route is a diagnostic only; it reports key presence and bounded L2 status/pending counts, not a general manager API. Financial commands in that source are Telegram command handlers, not a documented PocketPal HTTP contract.

Because production is still on version 56, this route inventory must not be treated as the definitive production route list until version 56's code is recovered. A PocketPal API should be added as a separate, authenticated, versioned route only after the production source has been safely backed up.

## Trust boundary and intended topology

```
PocketPal Cloudflare Talent
  -> HTTPS + PocketPal-specific credential stored in iOS Keychain
  -> authenticated, allowlisted API on manager 1 (L1)
       -> L1-owned read-only operations
       -> verified existing L1→L2 bridge -> goldstar-financial-v3 (L2)
```

The gateway must not be an arbitrary URL/method proxy. The model may choose only named operations from a strict schema; it must not supply arbitrary Cloudflare API paths, account IDs, headers, or methods. L1/L2 selection must be mapped server-side. The app must not receive either L1↔L2 bridge secret.

For direct Cloudflare resource administration (Workers, D1, KV, DNS, Access, secrets, deployments), neither inspected Worker source proves that an account-scoped Cloudflare API token is available. If those operations are required, create separate least-privilege tokens for each account and store them only as Worker secrets; never embed them in PocketPal or GitHub source. Begin with read-only inventory operations. Mutations require explicit user confirmation and audit records; destructive actions stay disabled until individually reviewed.

A static app key is extractable from a distributed binary if hardcoded. The PocketPal credential must be user-configurable/rotatable, stored only in Keychain, accepted only over HTTPS, and never echoed into model context, logs, or tool results. Prefer a short-lived or Cloudflare Access-based credential if a viable mobile authentication flow can be established.

## iOS build and installation constraints verified in this fork

- CI builds an unsigned iOS Simulator app with code signing disabled. That artifact is not an installable iPhone IPA.
- The release workflow has a macOS/TestFlight lane, but it requires App Store Connect API credentials, Fastlane Match certificate/profile storage, GitHub secrets, and a valid Apple signing identity.
- The checked-in Xcode project currently uses bundle identifier `ai.pocketpal`, upstream development team `MYXGXY23Y6`, and upstream Match profile names. These cannot be assumed valid for this fork or a separately signed private app.
- The fork needs a distinct bundle identifier and its own provisioning/signing material before an IPA can be installed or distributed. No signing secret should be added to the repository or printed in logs.

## Implementation sequence

1. Recover and back up the exact source of production L1 version 56. Do not substitute latest-uploaded preview version 60.
2. Complete the pending read-only L1→L2 bridge runtime test in the controlled preview; preserve the current fail-closed production deployments.
3. Complete/coordinate the blocked L1 registry/task API work (ORG-V1-003) and define a small versioned PocketPal API on L1. Initially expose only safe status/read operations, including a read-only L2 financial status call through the verified bridge.
4. Add PocketPal-specific authentication, request-size limits, rate limiting, strict operation schemas, redaction, and audit logging. Keep this credential separate from the L1↔L2 bridge secret.
5. Verify the L1 API and its L2 calls independently before changing PocketPal.
6. Add a dedicated Cloudflare Talent engine that calls only the L1 contract, validates arguments locally, aborts on cancellation, and emits safe summaries.
7. Add connection settings backed by Keychain for the L1 endpoint and rotatable PocketPal credential.
8. Add direct Cloudflare resource administration only after per-account API-token scopes and exact allowed operations are defined.
9. Set up a separately signed iOS build using a new bundle ID and user-owned Apple signing credentials.

## Explicit non-goals

- No change to the original PocketPal repository or its `main` branch.
- No change to either deployed Cloudflare Worker until the exact production source is backed up, reviewed, and the new route is tested independently.
- No existing L1↔L2 bridge secret in PocketPal, GitHub source, or GitHub Actions logs.
- No unrestricted Cloudflare API passthrough.
- No automatic deployment, deletion, or permission changes initiated solely by model output.
