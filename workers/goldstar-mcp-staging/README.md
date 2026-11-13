# Goldstar MCP Staging

This isolated staging project contains two Cloudflare Workers:

- `auth/`: OAuth 2.1 authorization server, Google OIDC sign-in, owner email allowlist, per-client consent, PKCE and token issuance.
- `resource/`: Streamable HTTP MCP server. It validates tokens through a Service Binding to the authorization Worker and exposes read-only staging tools.

The initial allowlisted Google identity is `goldstar.al.manager@gmail.com`. Google access tokens are not passed to MCP clients or stored in MCP token properties; only the verified subject and basic identity claims are retained.

## Deployment order

1. Deploy `auth/` with the existing `goldstar_mcp_oauth_staging` KV namespace.
2. Add Worker secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
3. Register the exact Google OAuth callback URL:
   `https://goldstar-mcp-auth-staging.goldstar-al-manager.workers.dev/callback`
4. Deploy `resource/` after the AuthServer service entrypoint is live.
5. Test OAuth discovery, PKCE, Google identity allowlisting, and MCP tools before entering the resource URL in ChatGPT.

## Safety boundary

No production Worker is referenced by either deployment configuration. No MCP write scope or write-capable tool is included. The first release exposes only gateway status and verified identity; additional L1/L2 read operations require separate endpoint and data-scope review.

## Cloudflare Workers Builds

Each subdirectory is an independent Workers Builds project. Set its root directory to the corresponding `workers/goldstar-mcp-staging/auth` or `workers/goldstar-mcp-staging/resource` path. Use `npm install` (or the platform's automatic dependency install) and `npx wrangler deploy`. Keep the production branch unchanged; deploy from the dedicated `staging/goldstar-mcp-oauth` branch.
