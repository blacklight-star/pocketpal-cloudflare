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

## Historical Cloudflare deployment and bridge verification (2026-11-06; superseded by the current state below)

The Worker Scripts API distinguishes uploaded versions from production deployments. The following state was checked on 2026-11-06:

- L1 script: `personal-ai-manager`. Latest uploaded candidate is version **74** (alias `pocketpal-test`), uploaded 2026-11-06. Version 74 is preview-only and is not present in any production deployment. The active production version remains **56** at 100%.
- L1 version 72 remains available under alias `bridge-test` and contains the diagnostic route `/__preview/financial-bridge`, restricted to host `bridge-test-personal-ai-manager.goldstar-al-manager.workers.dev`.
- L1 version 74 was built from the current uploaded v73 preview source, preserving its existing code and bindings. It adds the exact route `/pocketpal/v1/execute`, restricted to host `pocketpal-test-personal-ai-manager.goldstar-al-manager.workers.dev`, and the reviewed handler from `backend/pocketpal-api-v1.js`.
- Version 74 binds `DB` to the isolated preview database `pocketpal_gateway_preview` (`e67135cf-0098-43be-8f32-dde761fc8b22`, EU jurisdiction). Existing AI, CACHE, and secret bindings were inherited. It does not bind the production L1 D1 database.
- Production L1 remains version 56, bound to production D1 `2f9551be-0c6c-4750-9279-ba6035d60d26`. Version 74 has not been deployed to production.
- L1 `callFinancial()` targets `https://goldstar-financial-v3.goldstar-nsl83.workers.dev`; therefore this diagnostic is a read-only preview-to-L2-production bridge check, not a general PocketPal API and not the separate L2 staging test.
- The owner supplied a successful response from that route on 2026-11-06: both legacy and dedicated bridge-key presence flags were true; `bridgeOk=true`; status returned 0 approved rules, 113 legacy rules, 0 pending NDS, and `strategyReady=true`; the pending endpoint reported 5 total and 1 returned. The latter is expected because the route explicitly requests `limit=1`.
- L2 script is `goldstar-financial-v3`. Production remains version **19** at **100%**. L2 candidate version **23** is a staging candidate with null-safe empty pending-KV handling; it is explicitly not deployed and has no production data bindings.
- L1 and L2 production deployments have not been changed by this PocketPal work.

L1 source-backup investigation (2026-11-06):

- The L1 `CACHE` KV namespace contains two Worker-source backups: `backup-personal-ai-manager-6.2.1-before-isolation-test` and `backup-personal-ai-manager-pre-change-2026-10-31`. Both are 54,630 characters and have the same SHA-256 (`72c2fb4d7874d22f405433a8652ce19c726753b999d9315652f6a2f9bec7b25c`). A separate 6.2.0 backup is 53,256 characters; the D1 snapshot key `backup-ai-manager-db-2026-10-31` also exists.
- Prior project records reported that the live L1 v6.2.1 source matched the 54,630-character backup by length. This historical comparison did not record a SHA-256/ETag comparison.
- Cloudflare version metadata shows L1 versions 55 and 56 have the same script ETag (`47ebf88322598048d8a946d36b92c66f1994e62d4d375a102084135eab301a57)); version 56 adds the dedicated bridge secret binding. This is consistent with unchanged code between v55 and v56, but the Cloudflare API exposes only the latest uploaded script content, not the historical source bytes for v56.
- Therefore the 6.2.1 KV source is a strong recovery baseline for production v56, but exact byte-for-byte identity to the v56 artifact is not independently proven. Preserve it; do not overwrite it.

The live L1 D1 registry row `CORE_FINANCIAL_BRIDGE` has been updated to `preview_to_production_l2_verified_production_not_deployed`, with the owner-supplied test result and its limitations recorded. Task `FIN-V1-001` is `completed`; task `ORG-V1-003` (L1 registry/task-dispatch API) is now `in_progress`.

This test verifies only the diagnostic read path. It does not validate every L2 operation, approve any pending/legacy rule, enable trading, or prove that a general PocketPal API exists.

## Historical PocketPal gateway preview notes (versions 74–77; superseded by the current state below)

The live L1 Worker source was retrieved directly from the Cloudflare Scripts API on 2026-11-06. The current uploaded candidate (v72) contains the existing `callFinancial(endpoint, env, method, body)` helper and `sha256Hex(value)` helper required by the PocketPal handler. The source was parsed from the multipart response before modification; the upload validator accepted the resulting ES module.

- L1 candidate version **74** was uploaded with alias `pocketpal-test`. It adds `POST /pocketpal/v1/execute` and restricts this route to the exact preview hostname. The version upload did not create a production deployment.
- The handler uses the existing L1-to-L2 bridge helper for the fixed, allowlisted L2 GET operations. It does not expose bridge credentials to PocketPal and does not provide arbitrary URL, method, or path proxying.
- A separate EU D1 database, `pocketpal_gateway_preview` (`e67135cf-0098-43be-8f32-dde761fc8b22`), was created for preview isolation. It contains only the schema needed by the read-only gateway plus the rate-limit table; no production rows were copied.
- The preview D1 schema was created from the exact live L1 table definitions for `gs_org_units`, `gs_org_agents`, `gs_org_tasks`, `gs_org_connections`, `gs_org_access_policies`, `gs_l1_policy`, and `gs_l1_audit`. The migration `0001_pocketpal_rate_limits.sql` was applied to this preview database, not to production.
- Direct D1 checks passed for every SQL query used by the L1 read operations and for the audit insert. The atomic rate-limit SQL accepted requests 1–30, rejected request 31, and reset to 1 in the next minute window. Test rows were removed afterward.
- The Worker version upload succeeded and Cloudflare reports `has_preview=true`, alias `pocketpal-test`, and both `fetch` and `scheduled` handlers. Version 74 is absent from production deployments. The handler's recursive redaction also drops `__proto__`, `prototype`, and `constructor` keys to prevent prototype-pollution payloads. The PocketPal client now defaults to the exact isolated preview URL (`https://pocketpal-test-personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute`); production is not selected unless explicitly configured.
- An end-to-end HTTP request to the preview hostname could not be executed from the connected tool environment because outbound requests to `workers.dev` are blocked. The Worker preview hostname therefore still requires a real-device or external HTTP check.
- The dedicated `POCKETPAL_APP_KEY` secret has not been configured. The preview version inherits the existing L1-to-L2 bridge bindings, so the gateway remains restricted to the fixed read-only L2 GET allowlist; do not add any write operation. The gateway is intentionally fail-closed and will return HTTP 503 until that secret is set. No key has been generated or exposed in chat.
- The CI workflow now also builds an unsigned arm64 iOS device `.ipa` and uploads it as `pocketpal-ios-unsigned-ipa` for private sideloading after the build passes. This is not a signed/TestFlight IPA; it must be re-signed on the user's device or through a trusted sideloading workflow. The CI job has not run yet.
- GitHub Actions currently reports zero workflow runs and zero check runs for the PR head. CI, Node tests, TypeScript, lint, Jest, Android, and iOS builds are not yet verified.

Production L1 remains version 56 and its D1 database is unchanged. L2 production remains unchanged. No live trading, approval, ingestion, strategy synthesis, or data mutation endpoint was exposed.

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

1. Keep L1 version 73 on the isolated `pocketpal-test` preview alias. Do not promote it to production while the credential and runtime checks remain open.
2. Configure a dedicated random `POCKETPAL_APP_KEY` secret for the L1 Worker and enter the same value into the PocketPal credential store (iOS Keychain). It must remain separate from both L1↔L2 bridge keys.
3. From a real external client, verify preview HTTP behavior: valid credential + L1 `status`; invalid credential; missing credential; unsupported manager/operation; rate-limit boundary; audit failure. Confirm all successful responses are bounded and redacted.
4. Trigger and pass GitHub CI for PR #2, including `node --test backend/test-pocketpal-api-v1.mjs`, TypeScript, lint, Jest, and the configured platform builds. No check results currently exist.
5. Only after all preview tests and CI pass, review the PR and obtain explicit owner approval before any production D1 migration, production secret change, or production Worker deployment. Production promotion is a separate change and is not authorized by this preview upload.

## Explicit non-goals

- No change to the original PocketPal repository or its `main` branch.
- No change to either deployed Cloudflare Worker until the exact production source is backed up, reviewed, and the new route is tested independently.
- No existing L1↔L2 bridge secret in PocketPal, GitHub source, or GitHub Actions logs.
- No unrestricted Cloudflare API passthrough.
- No automatic deployment, deletion, or permission changes initiated solely by model output.


## Current verified state — version 80 (2026-11-08)

This section supersedes the earlier version-74 and version-77 implementation notes above.

- Active L1 Production remains version **56** at **100%** traffic. No PocketPal production deployment was created.
- Latest uploaded L1 Candidate is version **80** (ID `53599018-fe53-457c-b237-51f852a884ca`), `has_preview=true`, and is absent from Production deployment traffic.
- The immutable preview endpoint is `https://53599018-personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute`.
- The versioned preview hostname exposes only `/pocketpal/v1/execute` and `/pocketpal/v1/enroll`. Other L1 paths are rejected before the normal router.
- Candidate V80 inherits the dedicated `POCKETPAL_APP_KEY` secret binding, keeps `DB` isolated for audit/rate limiting, and binds `ORG_DB` to the separate `ai_manager_org_staging` snapshot. That snapshot contains 6 units, 45 agents, 12 tasks, 8 connections, 4 access policies, and 2 L1 policy records; all six tables were compared row-for-row with the Production source. Active Production V56 does not bind the PocketPal app key.
- Candidate code enforces HTTPS, Bearer authentication, an 8 KiB streaming request cap, atomic D1 rate limiting, fail-closed audit persistence, recursive redaction, and the fixed read-only manager/operation allowlist.
- The preview D1 migration is present only in the preview database. The Production L1 D1 schema was not altered. No Production Worker, route, traffic, secret, KV, D1, account, or permission change was made.
- The PocketPal control D1 currently has no successful gateway audit or rate-limit rows; its only enrollment token is expired. The separate ORG_DB staging snapshot is populated and exact-match verified. No valid-key end-to-end request has been confirmed.
- The hardening branch pins the app client and live smoke test to V80. Candidate V80's server-side financial preview URL points to hardened L2 Candidate V28. The smoke test checks unauthenticated execution (HTTP 401) and 404 responses for non-gateway, approval, and trade paths. This verifies the unauthenticated boundary, not a successful authenticated operation.
- The app-side key store uses iOS Keychain. The secret value is not included in source, CI, documentation, or chat. A real-device test with the owner-held key remains pending.
- Production L1, L2 Production, and the Production Trainer remain unchanged. Candidate uploads were preview-only; no Production deployment, approval, ingestion, strategy synthesis, or trade was performed.
