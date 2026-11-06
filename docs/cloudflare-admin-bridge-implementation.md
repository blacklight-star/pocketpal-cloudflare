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

## Current Cloudflare deployment and bridge verification

The Worker Scripts API distinguishes uploaded versions from production deployments. The following state was checked on 2026-11-06:

- L1 script: `personal-ai-manager`. Latest uploaded candidate is version **72** (alias `bridge-test`), uploaded 2026-11-05. It is not a production deployment. The active production version remains **56**.
- L1 version 72 contains the diagnostic route `/__preview/financial-bridge`, restricted to host `bridge-test-personal-ai-manager.goldstar-al-manager.workers.dev`. It calls `/status` and `/training/pending?limit=1` through `callFinancial()`.
- L1 `callFinancial()` targets `https://goldstar-financial-v3.goldstar-nsl83.workers.dev`; therefore this diagnostic is a read-only preview-to-L2-production bridge check, not a general PocketPal API and not the separate L2 staging test.
- The owner supplied a successful response from that route on 2026-11-06: both legacy and dedicated bridge-key presence flags were true; `bridgeOk=true`; status returned 0 approved rules, 113 legacy rules, 0 pending NDS, and `strategyReady=true`; the pending endpoint reported 5 total and 1 returned. The latter is expected because the route explicitly requests `limit=1`.
- L2 script is `goldstar-financial-v3`. Production remains version **19** at **100%**. L2 candidate version **23** is a staging candidate with null-safe empty pending-KV handling; it is explicitly not deployed and has no production data bindings.
- L1 and L2 production deployments have not been changed by this PocketPal work.

The live L1 D1 registry row `CORE_FINANCIAL_BRIDGE` has been updated to `preview_to_production_l2_verified_production_not_deployed`, with the owner-supplied test result and its limitations recorded. Task `FIN-V1-001` is `completed`; task `ORG-V1-003` (L1 registry/task-dispatch API) remains `blocked`.

This test verifies only the diagnostic read path. It does not validate every L2 operation, approve any pending/legacy rule, enable trading, or prove that a general PocketPal API exists.

## Missing capability for PocketPal

The inspected L1 v6.2.2 source (latest uploaded version 72) does not define `/pocketpal/v1/execute` or another general PocketPal manager API. Its `/__preview/financial-bridge` route is diagnostic only; it returns key-presence flags and bounded L2 status/pending counts. Financial commands in this source are Telegram command handlers, not a documented PocketPal HTTP contract.

The production L1 version 56 remains separate from the latest uploaded candidate. Its exact source must be recovered and backed up before any production patch. The read-only bridge diagnostic is now verified in preview, so the remaining backend work is to recover production L1 source, unblock/complete `ORG-V1-003`, and add a separate PocketPal-authenticated, versioned API without exposing bridge credentials.

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

1. Recover and back up the exact source of production L1 version 56. Do not substitute latest-uploaded preview version 72.
2. Preserve the now-verified read-only preview-to-production-L2 bridge and keep production deployments unchanged.
3. Unblock/complete the L1 registry/task API work (ORG-V1-003), then add a separate versioned PocketPal API on L1. Initially expose only safe status/read operations, including L1 registry summaries and a read-only L2 financial status call through the verified bridge.
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
