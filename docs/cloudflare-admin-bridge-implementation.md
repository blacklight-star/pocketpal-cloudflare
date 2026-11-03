# Cloudflare Admin Bridge — implementation notes

Status: architecture discovery; no production credentials or Cloudflare API tokens are stored in this repository.

## Repository findings

- The app is React Native 0.87.1 / TypeScript and already has a Talent engine registry.
- Built-in engines are registered in `src/services/talents/index.ts`; the Pal editor exposes every registered engine through `src/components/PalsSheets/TalentSection.tsx`.
- `TalentEngine.execute(args, ctx?)` is the extension contract. Tool results are returned to the model as text, so the Cloudflare engine must return bounded, redacted summaries rather than credentials or raw secret-bearing API payloads.
- `react-native-keychain` is already a dependency and is used by `src/store/SearchProviderStore.ts` for provider credentials. A separate service namespace should be used for the Cloudflare app credential; do not store Cloudflare account API tokens in the app.
- The existing Talent UI registration is separate from engine registration. A Cloudflare tool may initially be exposed through the existing generic TalentSection without a bespoke UI.
- The app is a bare React Native project; no Expo/EAS configuration exists.

## Cloudflare accounts discovered through the connected account sessions

- Manager 1 account: `443206d2fcb0e88cbe6ca6f5fa8c14e9`; current Worker `personal-ai-manager`.
- Manager 2 account: `28e81766ca187c00138b277cf502705b`; current Workers include `goldstar-financial-v3`, `goldstar-trainer`, `trading-research-agent`, and `tv-ingest`.
- The Worker settings show existing secret bindings, but secret values are not readable and must never be copied into source control or exposed to the mobile app.
- These findings confirm that the two Cloudflare accounts are separately connected and independently addressable. They do not prove that the two deployed Workers already expose a common PocketPal API.

## Required trust boundary

PocketPal must never contain either manager's Cloudflare API token. The intended topology is:

```
PocketPal Talent
  -> HTTPS request with app credential held in iOS Keychain
  -> authenticated gateway Worker in manager 1 account
       -> fixed operation allowlist + role authorization
       -> manager 1 Cloudflare API token (Worker secret)
       -> manager 2 Cloudflare API token (Worker secret)
```

The gateway must not be an arbitrary URL/method proxy. The model may choose only named operations from a strict schema; it must not supply arbitrary Cloudflare API paths, account IDs, headers, or methods. The gateway maps role names to fixed account IDs server-side. The model must not be allowed to promote itself from manager 2 to manager 1.

The two upstream Cloudflare API tokens must be separate, account-scoped, and least-privilege. Read-only operations should be implemented and tested first. Mutations (deploy, edit, delete, secrets, bindings, DNS, or access-policy changes) must be separately allowlisted, require an explicit user confirmation in the app, and produce an audit record. Destructive operations should remain disabled until individually reviewed.

A static app key is not equivalent to a Cloudflare API token, but it is still extractable from a distributed app if hardcoded. The app credential must be user-configurable/rotatable, stored only in Keychain, and accepted by the gateway only over HTTPS. Prefer short-lived credentials or Cloudflare Access-based identity if a viable mobile flow can be established.

## iOS build and installation constraints verified in this fork

- The CI workflow builds an unsigned iOS Simulator app with code signing disabled. That artifact is not an installable iPhone IPA.
- The release workflow does have a macOS/TestFlight lane, but it depends on Apple App Store Connect API credentials, Fastlane Match certificate/profile storage, GitHub secrets, and an Apple signing identity.
- The checked-in Xcode project currently uses bundle identifier `ai.pocketpal`, upstream development team `MYXGXY23Y6`, and upstream Match profile names. Those cannot be assumed valid for this fork or a separately signed private app.
- This fork must use a distinct bundle identifier and its own provisioning/signing material before an IPA can be installed or distributed. No signing secret should be added to the repository or printed in logs.

## Implementation sequence

1. Define and deploy a narrow gateway contract in the manager 1 account. Add two separate upstream API-token secrets there; do not change existing Workers or their secrets.
2. Verify the gateway's authentication, role-to-account mapping, allowlist, response redaction, rate limits, and audit behavior independently of PocketPal.
3. Add a dedicated Cloudflare Talent engine that calls only the gateway contract, validates every argument locally, aborts on cancellation, and emits safe summaries.
4. Add a small connection-settings surface backed by Keychain for the gateway URL and rotatable app credential. Never expose upstream Cloudflare tokens in the UI, model prompt, tool result, logs, or app bundle.
5. Add unit tests for role isolation, schema validation, malformed responses, timeouts, cancellation, secret redaction, and confirmation boundaries.
6. Set up a separately signed iOS build using a new bundle ID and user-owned Apple signing credentials. Keep the upstream PocketPal app and the fork independently installable.

## Explicit non-goals

- No change to the original PocketPal repository or its `main` branch.
- No Cloudflare account token in PocketPal, GitHub source, or GitHub Actions logs.
- No unrestricted Cloudflare API passthrough.
- No automatic deployment, deletion, or permission changes initiated solely by model output.
