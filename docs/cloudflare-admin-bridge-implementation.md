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

## Critical deployment-state distinction

The Worker Scripts API returns the **latest uploaded source**, which is not necessarily the version receiving production traffic.

- Latest uploaded L1 version: version **59**, source declares `CONFIG.VERSION = 6.2.2`; it is annotated `github-recovery-once`.
- Version **58** is annotated `bridge-test` and described as a read-only bridge preview candidate.
- The actual production deployment is version **56** at **100% traffic** (deployment ID `f9498b43-8d5c-45e5-8b6e-9501b9feb3cc`). Version 56's annotations say `Add secret: GOLDSTAR_FINANCIAL_BRIDGE_KEY`.
- The current script-content endpoint returns version 59 even when a version-56 query parameter is supplied. The version-specific GET endpoint exposes metadata/bindings, not the source code.

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

The latest uploaded L1 source does not define a general PocketPal API. Its HTTP route list includes `/`, `/webhook`, `/setup`, `/github-test`, `/agent-report`, and internal/preview routes. Financial commands in that source are Telegram command handlers, not a documented PocketPal HTTP contract.

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

1. Recover and back up the exact source of production L1 version 56. Do not substitute latest-uploaded version 59.
2. Verify the existing L1→L2 bridge and its runtime health in a controlled preview.
3. Define a small versioned PocketPal API on L1. Initially expose only safe status/read operations, including a read-only L2 financial status call through the verified bridge.
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
