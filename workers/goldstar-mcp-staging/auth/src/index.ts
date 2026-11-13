import {
  AuthorizationError,
  OAuthAuthorizationServer,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_ISSUER: string;
  MCP_RESOURCE: string;
  GOLDSTAR_OWNER_EMAIL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

interface GoogleIdentity {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  idToken: string;
  idTokenExpiresAt: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
}

interface GoogleJwtClaims {
  iss: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  iat: number;
  nonce: string;
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

interface UpstreamState {
  verifier: string;
  nonce: string;
}

export interface GoldstarAuthProps {
  email: string;
  name: string;
  googleSub: string;
  role: "owner";
  grantedScopes: string[];
  // Server-side only. Never return this bearer token through an MCP tool.
  googleIdToken?: string;
  googleIdTokenExpiresAt?: number;
}

const SCOPES_SUPPORTED = ["mcp:read", "gcp:read", "gcp:write", "offline_access"] as const;
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_DISCOVERY_ENDPOINT = "https://accounts.google.com/.well-known/openid-configuration";
const encoder = new TextEncoder();

const authorizationServer = new OAuthAuthorizationServer<Env>({
  issuer: "https://goldstar-mcp-auth-staging.goldstar-al-manager.workers.dev",
  resources: [
    "https://goldstar-mcp-resource-staging.goldstar-al-manager.workers.dev/mcp",
  ],
  scopesSupported: [...SCOPES_SUPPORTED],
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/oauth/register",
});

function htmlEscape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function localError(message: string, status = 400): Response {
  return new Response(htmlEscape(message), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return localError(error.description, 400);
  }
  throw error;
}

function consentHtml(details: ConsentDescription, handle: string): string {
  const clientName = htmlEscape(details.clientName);
  const domainText = details.clientDomain
    ? `Publisher domain: <strong>${htmlEscape(details.clientDomain)}</strong>`
    : "The requesting application has not published a verified client domain.";
  const scopes = details.scope
    .filter((scope) => SCOPES_SUPPORTED.includes(scope as (typeof SCOPES_SUPPORTED)[number]))
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${htmlEscape(scope)}" checked> ${htmlEscape(scope)}</label>`,
    )
    .join("<br>");
  const googleCloudWriteWarning = details.scope.includes("gcp:write")
    ? "<p><strong>Google Cloud write access:</strong> this permission can change resources in the configured project. Only approve it when you intend to allow those changes. Sensitive operations still require a separate explicit confirmation.</p>"
    : "";
  const loopbackWarning = details.redirectIsLoopback
    ? "<p><strong>Warning:</strong> access will be returned to an application on this device. Continue only if you started this sign-in.</p>"
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Goldstar MCP access approval</title></head>
<body>
<main>
<h1>Allow ${clientName} to access Goldstar MCP Staging?</h1>
<p>${domainText}</p>
<p>Authorization response will be sent to: <strong>${htmlEscape(details.redirectHost)}</strong></p>
${loopbackWarning}
<p>Requested access:</p>
${googleCloudWriteWarning}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${htmlEscape(handle)}">
${scopes}
<p>
<button type="submit" name="decision" value="approve">Allow selected access</button>
<button type="submit" name="decision" value="deny">Deny</button>
</p>
</form>
</main>
</body>
</html>`;
}

function makeConsentResponse(html: string, consentHeaders: Headers): Response {
  const headers = new Headers(consentHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(html, { status: 200, headers });
}

function base64UrlToBytes(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseJwtPart<T>(value: string): T {
  const bytes = base64UrlToBytes(value);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function verifyGoogleIdToken(
  idToken: string,
  expectedNonce: string,
  env: Env,
): Promise<GoogleIdentity | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;

  const header = parseJwtPart<{ alg?: string; kid?: string }>(parts[0]);
  const claims = parseJwtPart<GoogleJwtClaims>(parts[1]);
  if (header.alg !== "RS256" || !header.kid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (
    !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) ||
    !claims.sub ||
    !claims.email ||
    claims.email_verified !== true ||
    claims.nonce !== expectedNonce ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    now - claims.iat > 3600
  ) {
    return null;
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    audiences.length === 0 ||
    audiences.some((audience) => typeof audience !== "string" || !audience) ||
    !audiences.includes(env.GOOGLE_CLIENT_ID) ||
    (claims.azp !== undefined && claims.azp !== env.GOOGLE_CLIENT_ID) ||
    (audiences.length > 1 && claims.azp !== env.GOOGLE_CLIENT_ID)
  ) {
    return null;
  }

  const discoveryResponse = await fetch(GOOGLE_DISCOVERY_ENDPOINT, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!discoveryResponse.ok) throw new Error("Google OIDC discovery unavailable");
  const discovery = (await discoveryResponse.json()) as { jwks_uri?: string };
  if (!discovery.jwks_uri) throw new Error("Google OIDC key endpoint missing");
  const jwksUrl = new URL(discovery.jwks_uri);
  if (
    jwksUrl.protocol !== "https:" ||
    jwksUrl.hostname !== "www.googleapis.com" ||
    jwksUrl.pathname !== "/oauth2/v3/certs"
  ) {
    throw new Error("Unexpected Google OIDC key endpoint");
  }

  const keysResponse = await fetch(jwksUrl, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!keysResponse.ok) throw new Error("Google OIDC signing keys unavailable");
  const jwks = (await keysResponse.json()) as {
    keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string; kty?: string }>;
  };
  const jwk = jwks.keys.find(
    (key) => key.kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig"),
  );
  if (!jwk) return null;

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureBytes = base64UrlToBytes(parts[2]);
  const signatureBuffer = new ArrayBuffer(signatureBytes.byteLength);
  new Uint8Array(signatureBuffer).set(signatureBytes);
  const signedContentBytes = encoder.encode(`${parts[0]}.${parts[1]}`);
  const signedContentBuffer = new ArrayBuffer(signedContentBytes.byteLength);
  new Uint8Array(signedContentBuffer).set(signedContentBytes);
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signatureBuffer,
    signedContentBuffer,
  );
  if (!validSignature) return null;

  const email = claims.email.trim().toLowerCase();
  if (email !== env.GOLDSTAR_OWNER_EMAIL.trim().toLowerCase()) return null;

  return {
    sub: claims.sub,
    email,
    email_verified: claims.email_verified,
    name: claims.name?.trim() || email,
    idToken,
    idTokenExpiresAt: claims.exp,
  };
}

async function getAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    const client = await oauth.lookupClient(authRequest.clientId);
    if (!client) return localError("Unknown OAuth client.", 400);

    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return makeConsentResponse(consentHtml(details, consent.handle), consent.headers);
  } catch (error) {
    return authErrorResponse(error);
  }
}

async function postAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);
  try {
    const form = await request.formData();
    const handle = form.get("handle");
    const decision = form.get("decision");
    if (typeof handle !== "string" || !handle) return localError("Invalid or expired approval request.");
    if (decision === "deny") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (decision !== "approve") return localError("Invalid approval decision.");

    const requestedScopes = form
      .getAll("scope")
      .filter((scope): scope is string => typeof scope === "string");
    const grantedScopes = [...new Set(
      requestedScopes.filter((scope) =>
        SCOPES_SUPPORTED.includes(scope as (typeof SCOPES_SUPPORTED)[number]),
      ),
    )];
    if (!grantedScopes.includes("mcp:read")) {
      return localError("The required mcp:read permission was not approved.", 403);
    }
    if (grantedScopes.includes("gcp:write") && !grantedScopes.includes("gcp:read")) {
      return localError("Google Cloud write access requires read access to the same project.", 403);
    }
    const approved = await oauth.approveConsent(request, handle, {
      scope: grantedScopes,
    });

    const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const nonce = crypto.randomUUID();
    const challengeDigest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(challengeDigest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const upstream = await oauth.beginUpstream(approved.request, {
      data: { verifier, nonce } satisfies UpstreamState,
      headers: approved.headers,
    });

    const googleUrl = new URL(GOOGLE_AUTH_ENDPOINT);
    googleUrl.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: new URL("/callback", request.url).href,
      response_type: "code",
      scope: "openid email profile",
      state: upstream.state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      nonce,
      prompt: "select_account",
    }).toString();

    upstream.headers.set("Location", googleUrl.href);
    return new Response(null, { status: 302, headers: upstream.headers });
  } catch (error) {
    return authErrorResponse(error);
  }
}

async function googleCallback(request: Request, env: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);
  let originalRequest: AuthRequest;
  let upstreamState: UpstreamState;
  let clearHeaders: Headers;

  try {
    const finished = await oauth.finishUpstream<UpstreamState>(request);
    originalRequest = finished.request;
    upstreamState = finished.data;
    clearHeaders = finished.headers;
  } catch (error) {
    return authErrorResponse(error);
  }

  const callbackUrl = new URL(request.url);
  const providerError = callbackUrl.searchParams.get("error");
  if (providerError) {
    clearHeaders.set(
      "Location",
      authorizationErrorRedirect(originalRequest, "access_denied"),
    );
    return new Response(null, { status: 302, headers: clearHeaders });
  }

  const code = callbackUrl.searchParams.get("code");
  if (!code) return localError("Google callback did not include an authorization code.", 400);

  const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: upstreamState.verifier,
      grant_type: "authorization_code",
      redirect_uri: new URL("/callback", request.url).href,
    }),
  });

  if (!tokenResponse.ok) {
    return localError("Google sign-in could not be completed. Restart the authorization flow.", 502);
  }
  const tokens = (await tokenResponse.json()) as GoogleTokenResponse;
  if (!tokens.id_token) {
    return localError("Google did not return an OpenID identity token.", 502);
  }

  let identity: GoogleIdentity | null;
  try {
    identity = await verifyGoogleIdToken(tokens.id_token, upstreamState.nonce, env);
  } catch {
    return localError("Google identity verification is temporarily unavailable.", 503);
  }
  if (!identity) {
    clearHeaders.set(
      "Location",
      authorizationErrorRedirect(originalRequest, "access_denied"),
    );
    return new Response(null, { status: 302, headers: clearHeaders });
  }

  const authorization = await oauth.completeAuthorization({
    request: originalRequest,
    userId: identity.sub,
    metadata: {
      email: identity.email,
      name: identity.name ?? identity.email,
    },
    scope: originalRequest.scope,
    props: {
      email: identity.email,
      name: identity.name ?? identity.email,
      googleSub: identity.sub,
      role: "owner",
      grantedScopes: originalRequest.scope.filter((scope) =>
        SCOPES_SUPPORTED.includes(scope as (typeof SCOPES_SUPPORTED)[number]),
      ),
      // Retain the one-hour Google ID token only for sessions explicitly
      // granted Google Cloud scopes; it is never returned to the MCP client.
      ...(originalRequest.scope.some((scope) => scope === "gcp:read" || scope === "gcp:write")
        ? {
            googleIdToken: identity.idToken,
            googleIdTokenExpiresAt: identity.idTokenExpiresAt,
          }
        : {}),
    } satisfies GoldstarAuthProps,
  });

  clearHeaders.set("Location", authorization.redirectTo);
  return new Response(null, { status: 302, headers: clearHeaders });
}

export default class AuthServer extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({
        service: "goldstar-mcp-auth-staging",
        status: "ok",
        googleConfigured: Boolean(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET),
        ownerRestricted: true,
      });
    }
    if (path === "/authorize" && request.method === "GET") {
      return getAuthorize(request, this.env);
    }
    if (path === "/authorize" && request.method === "POST") {
      return postAuthorize(request, this.env);
    }
    if (path === "/callback" && request.method === "GET") {
      return googleCallback(request, this.env);
    }
    return authorizationServer.fetch(request, this.env, this.ctx);
  }

  validateToken(resource: string, token: string) {
    return authorizationServer.validateToken(resource, token, this.env);
  }
}