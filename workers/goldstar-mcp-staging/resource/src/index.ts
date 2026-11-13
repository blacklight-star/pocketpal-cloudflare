import {
  OAuthResourceServer,
  insufficientScope,
  type AuthorizationServerBinding,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

interface Env {
  AUTH_SERVER: AuthorizationServerBinding<GoldstarAuthProps>;
  MCP_RESOURCE: string;
  OAUTH_ISSUER: string;
  GCP_PROJECT_ID: string;
  GCP_PROJECT_NUMBER: string;
  GCP_SERVICE_ACCOUNT_EMAIL: string;
  GCP_OIDC_ISSUER: string;
  GCP_OIDC_KEY_ID: string;
  GCP_OIDC_PUBLIC_JWK: string;
  GCP_OIDC_SIGNING_KEY: CryptoKey;
  GCP_WIF_AUDIENCE: string;
}

interface GoldstarAuthProps {
  email: string;
  name: string;
  googleSub: string;
  role: "owner";
  grantedScopes: string[];
}

interface GoogleStsResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
}

interface GoogleImpersonationResponse {
  accessToken?: string;
  expireTime?: string;
}

const RESOURCE = "https://goldstar-mcp-resource-staging.goldstar-al-manager.workers.dev/mcp";
const ISSUER = "https://goldstar-mcp-auth-staging.goldstar-al-manager.workers.dev";
const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GCP_SUBJECT = "goldstar-mcp-resource-staging";
const GCP_ENABLE_API_ALLOWLIST = new Set([
  "cloudresourcemanager.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "serviceusage.googleapis.com",
  "sts.googleapis.com",
]);
const encoder = new TextEncoder();

function jsonResponse(value: unknown, cacheControl = "no-store"): Response {
  return Response.json(value, {
    headers: {
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJsonBase64Url(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function getPublicJwk(env: Env): JsonWebKey & { kid: string; alg: string; use: string } {
  const source = JSON.parse(env.GCP_OIDC_PUBLIC_JWK) as JsonWebKey & {
    kid?: string;
    alg?: string;
    use?: string;
  };
  if (source.kty !== "RSA" || !source.n || !source.e || source.d) {
    throw new Error("GCP OIDC public key configuration is invalid.");
  }
  return {
    kty: "RSA",
    n: source.n,
    e: source.e,
    use: "sig",
    alg: "RS256",
    kid: env.GCP_OIDC_KEY_ID,
  };
}

function oidcUnavailable(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "60",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function oidcDiscovery(env: Env): Response {
  if (!env.GCP_OIDC_ISSUER || !env.GCP_OIDC_KEY_ID || !env.GCP_OIDC_PUBLIC_JWK) {
    return oidcUnavailable("OIDC issuer is not configured.");
  }
  return jsonResponse(
    {
      issuer: env.GCP_OIDC_ISSUER,
      jwks_uri: env.GCP_OIDC_ISSUER + "/.well-known/jwks.json",
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      claims_supported: ["iss", "sub", "aud", "iat", "exp", "jti"],
    },
    "public, max-age=300",
  );
}

function oidcJwks(env: Env): Response {
  if (!env.GCP_OIDC_ISSUER || !env.GCP_OIDC_KEY_ID || !env.GCP_OIDC_PUBLIC_JWK) {
    return oidcUnavailable("OIDC signing key is not configured.");
  }
  try {
    return jsonResponse(
      { keys: [getPublicJwk(env)] },
      "public, max-age=300",
    );
  } catch {
    return oidcUnavailable("OIDC public key configuration is invalid.");
  }
}

async function createGcpSubjectToken(env: Env): Promise<string> {
  if (
    !env.GCP_OIDC_ISSUER ||
    !env.GCP_OIDC_KEY_ID ||
    !env.GCP_OIDC_SIGNING_KEY ||
    !env.GCP_WIF_AUDIENCE
  ) {
    throw new Error("Google Cloud federation is not fully configured.");
  }

  const privateKey = env.GCP_OIDC_SIGNING_KEY;

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: env.GCP_OIDC_KEY_ID,
  };
  const claims = {
    iss: env.GCP_OIDC_ISSUER,
    sub: GCP_SUBJECT,
    aud: env.GCP_WIF_AUDIENCE,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
  };
  const signingInput = encodeJsonBase64Url(header) + "." + encodeJsonBase64Url(claims);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    toArrayBuffer(encoder.encode(signingInput)),
  );
  return signingInput + "." + bytesToBase64Url(new Uint8Array(signature));
}

async function getGoogleCloudAccessToken(env: Env): Promise<string> {
  if (!env.GCP_WIF_AUDIENCE || !env.GCP_SERVICE_ACCOUNT_EMAIL) {
    throw new Error("Google Cloud workload identity settings are incomplete.");
  }

  const subjectToken = await createGcpSubjectToken(env);
  const exchangeBody = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: env.GCP_WIF_AUDIENCE,
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: subjectToken,
    scope: GOOGLE_CLOUD_SCOPE,
  });

  const exchangeResponse = await fetch("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: exchangeBody,
  });
  if (!exchangeResponse.ok) {
    throw new Error("Google Security Token Service rejected the federation (" + exchangeResponse.status + ").");
  }
  const exchanged = (await exchangeResponse.json()) as GoogleStsResponse;
  if (!exchanged.access_token) {
    throw new Error("Google Security Token Service returned no access token.");
  }

  const serviceAccount = encodeURIComponent(env.GCP_SERVICE_ACCOUNT_EMAIL);
  const impersonationResponse = await fetch(
    "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
      serviceAccount +
      ":generateAccessToken",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + exchanged.access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: [GOOGLE_CLOUD_SCOPE],
        lifetime: "600s",
      }),
    },
  );
  if (!impersonationResponse.ok) {
    throw new Error("Google service-account impersonation failed (" + impersonationResponse.status + ").");
  }
  const impersonated = (await impersonationResponse.json()) as GoogleImpersonationResponse;
  if (!impersonated.accessToken) {
    throw new Error("Google IAM Credentials returned no impersonated access token.");
  }
  return impersonated.accessToken;
}

async function googleCloudRequest(
  url: string,
  accessToken: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error("Google Cloud API returned HTTP " + response.status + ".");
  }
  return (await response.json()) as Record<string, unknown>;
}

function toolText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected Google Cloud error.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function createServer() {
  const server = new McpServer({
    name: "Goldstar MCP Staging",
    version: "0.2.0",
  });

  const auth = getMcpAuthContext();
  const props = auth?.props as Partial<GoldstarAuthProps> | undefined;
  const grantedScopes = new Set(
    Array.isArray(props?.grantedScopes) ? props.grantedScopes : [],
  );
  const isOwner =
    props?.role === "owner" &&
    typeof props.email === "string" &&
    props.email.trim().toLowerCase() === "goldstar.al.manager@gmail.com";
  const bindings = env as unknown as Env;
  const gcpConfigured = Boolean(
    bindings.GCP_PROJECT_ID &&
      bindings.GCP_SERVICE_ACCOUNT_EMAIL &&
      bindings.GCP_WIF_AUDIENCE &&
      bindings.GCP_OIDC_ISSUER &&
      bindings.GCP_OIDC_KEY_ID &&
      bindings.GCP_OIDC_PUBLIC_JWK &&
      bindings.GCP_OIDC_SIGNING_KEY,
  );

  server.registerTool(
    "goldstar_mcp_status",
    {
      description: "Read-only status of the Goldstar staging MCP gateway and the authenticated owner identity.",
      inputSchema: z.object({}),
    },
    async () => {
      const identity = getMcpAuthContext()?.props ?? {};
      return toolText({
        service: "goldstar-mcp-resource-staging",
        status: "ok",
        mode: "staging",
        access: "read-only by default; Google Cloud tools are separately scoped",
        authenticated: Boolean((identity as Record<string, unknown>).email),
        ownerEmail:
          typeof (identity as Record<string, unknown>).email === "string"
            ? (identity as Record<string, string>).email
            : null,
        googleCloudToolsReady: gcpConfigured,
      });
    },
  );

  server.registerTool(
    "goldstar_authenticated_identity",
    {
      description: "Return the verified Google identity attached to this MCP session. Does not reveal Google tokens.",
      inputSchema: z.object({}),
    },
    async () => {
      const identity = (getMcpAuthContext()?.props ?? {}) as Partial<GoldstarAuthProps>;
      return toolText({
        email: typeof identity.email === "string" ? identity.email : null,
        name: typeof identity.name === "string" ? identity.name : null,
        role: identity.role === "owner" ? "owner" : "unknown",
        identityProvider: "Google OpenID Connect",
      });
    },
  );

  if (isOwner && gcpConfigured && grantedScopes.has("gcp:read")) {
    server.registerTool(
      "gcp_project_info",
      {
        description: "Read the fixed Goldstar Google Cloud project metadata. This tool cannot select another project.",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const accessToken = await getGoogleCloudAccessToken(bindings);
          const project = await googleCloudRequest(
            "https://cloudresourcemanager.googleapis.com/v3/projects/" +
              encodeURIComponent(bindings.GCP_PROJECT_NUMBER),
            accessToken,
          );
          console.info(
            JSON.stringify({
              event: "goldstar_gcp_project_read",
              actor: props?.email,
              projectId: bindings.GCP_PROJECT_ID,
              at: new Date().toISOString(),
            }),
          );
          return toolText(project);
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.registerTool(
      "gcp_list_enabled_apis",
      {
        description: "List enabled Google APIs in the fixed Goldstar project.",
        inputSchema: z.object({
          pageSize: z.number().int().min(1).max(200).default(100),
          pageToken: z.string().max(2048).optional(),
        }),
      },
      async ({ pageSize, pageToken }) => {
        try {
          const accessToken = await getGoogleCloudAccessToken(bindings);
          const url = new URL(
            "https://serviceusage.googleapis.com/v1/projects/" +
              encodeURIComponent(bindings.GCP_PROJECT_NUMBER) +
              "/services",
          );
          url.searchParams.set("filter", "state:ENABLED");
          url.searchParams.set("pageSize", String(pageSize));
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          const result = await googleCloudRequest(url.toString(), accessToken);
          console.info(
            JSON.stringify({
              event: "goldstar_gcp_enabled_apis_listed",
              actor: props?.email,
              projectId: bindings.GCP_PROJECT_ID,
              at: new Date().toISOString(),
            }),
          );
          return toolText({
            projectId: bindings.GCP_PROJECT_ID,
            services: result.services ?? [],
            nextPageToken: result.nextPageToken ?? null,
          });
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (isOwner && gcpConfigured && grantedScopes.has("gcp:read")) {
    server.registerTool(
      "gcp_operation_status",
      {
        description: "Read the status of a Google Service Usage long-running operation previously returned by gcp_enable_api. Project identity is fixed by this Worker.",
        inputSchema: z.object({
          operationName: z
            .string()
            .regex(/^operations\/[A-Za-z0-9_-]+$/)
            .max(256),
        }),
      },
      async ({ operationName }) => {
        try {
          const accessToken = await getGoogleCloudAccessToken(bindings);
          const result = await googleCloudRequest(
            "https://serviceusage.googleapis.com/v1/" + operationName,
            accessToken,
          );
          console.info(
            JSON.stringify({
              event: "goldstar_gcp_operation_status_read",
              actor: props?.email,
              projectId: bindings.GCP_PROJECT_ID,
              at: new Date().toISOString(),
            }),
          );
          return toolText(result);
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (isOwner && gcpConfigured && grantedScopes.has("gcp:write")) {
    server.registerTool(
      "gcp_enable_api",
      {
        description:
          "Enable one Google API in the fixed Goldstar project. This can change service availability and may enable billable usage. Call only after the owner explicitly confirms the exact confirmation phrase for this API and project.",
        inputSchema: z.object({
          serviceId: z
            .string()
            .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.googleapis\.com$/)
            .max(255),
          confirmation: z.string().max(300),
        }),
      },
      async ({ serviceId, confirmation }) => {
        const expected =
          "ENABLE " + serviceId + " IN " + bindings.GCP_PROJECT_ID;
        if (!GCP_ENABLE_API_ALLOWLIST.has(serviceId)) {
          return toolError(
            new Error("This API is not in the staged allowlist. It requires a deliberate code review and update before it can be enabled."),
          );
        }
        if (confirmation !== expected) {
          return toolError(
            new Error("Explicit confirmation required. The owner must confirm exactly: " + expected),
          );
        }
        try {
          const accessToken = await getGoogleCloudAccessToken(bindings);
          const result = await googleCloudRequest(
            "https://serviceusage.googleapis.com/v1/projects/" +
              encodeURIComponent(bindings.GCP_PROJECT_NUMBER) +
              "/services/" +
              encodeURIComponent(serviceId) +
              ":enable",
            accessToken,
            "POST",
          );
          console.info(
            JSON.stringify({
              event: "goldstar_gcp_api_enable_requested",
              actor: props?.email,
              projectId: bindings.GCP_PROJECT_ID,
              serviceId,
              confirmation: "owner-confirmed",
              at: new Date().toISOString(),
            }),
          );
          return toolText({
            projectId: bindings.GCP_PROJECT_ID,
            serviceId,
            operation: result,
            note: "Google returned a long-running operation. Poll its operation name to verify completion.",
          });
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  return server;
}

const mcpHandler = createMcpHandler(createServer);

const resourceServer = new OAuthResourceServer<Env, GoldstarAuthProps>({
  resourceMetadata: {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    resource_name: "Goldstar L1 and L2 staging gateway",
  },
  requiredScopes: ["mcp:read"],
  validateToken: (environment) => environment.AUTH_SERVER.validateToken,
  handler: {
    fetch(request, environment, ctx) {
      if (!ctx.auth.scope.includes("mcp:read")) {
        return insufficientScope(ctx.auth, ["mcp:read"]);
      }
      return mcpHandler(request, environment, ctx);
    },
  },
});

export default {
  fetch(request: Request, environment: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/.well-known/openid-configuration") {
      return Promise.resolve(oidcDiscovery(environment));
    }
    if (request.method === "GET" && path === "/.well-known/jwks.json") {
      return Promise.resolve(oidcJwks(environment));
    }
    return resourceServer.fetch(request, environment, ctx);
  },
};
