import {
  OAuthResourceServer,
  insufficientScope,
  type AuthorizationServerBinding,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  AUTH_SERVER: AuthorizationServerBinding<GoldstarAuthProps>;
  MCP_RESOURCE: string;
  OAUTH_ISSUER: string;
}

interface GoldstarAuthProps {
  email: string;
  name: string;
  googleSub: string;
  role: "owner";
}

const RESOURCE = "https://goldstar-mcp-resource-staging.goldstar-al-manager.workers.dev/mcp";
const ISSUER = "https://goldstar-mcp-auth-staging.goldstar-al-manager.workers.dev";

function createServer() {
  const server = new McpServer({
    name: "Goldstar MCP Staging",
    version: "0.1.0",
  });

  server.registerTool(
    "goldstar_mcp_status",
    {
      description: "Read-only status of the Goldstar staging MCP gateway and the authenticated owner identity.",
      inputSchema: z.object({}),
    },
    async () => {
      const auth = getMcpAuthContext();
      const props = auth?.props ?? {};
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              service: "goldstar-mcp-resource-staging",
              status: "ok",
              mode: "staging",
              access: "read-only",
              authenticated: Boolean(props.email),
              ownerEmail: typeof props.email === "string" ? props.email : null,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "goldstar_authenticated_identity",
    {
      description: "Return the verified Google identity attached to this MCP session. Does not reveal Google tokens.",
      inputSchema: z.object({}),
    },
    async () => {
      const props = getMcpAuthContext()?.props ?? {};
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              email: typeof props.email === "string" ? props.email : null,
              name: typeof props.name === "string" ? props.name : null,
              role: props.role === "owner" ? "owner" : "unknown",
              identityProvider: "Google OpenID Connect",
            }),
          },
        ],
      };
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default new OAuthResourceServer<Env, GoldstarAuthProps>({
  resourceMetadata: {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    resource_name: "Goldstar L1 and L2 staging gateway",
  },
  requiredScopes: ["mcp:read"],
  validateToken: (env) => env.AUTH_SERVER.validateToken,
  handler: {
    fetch(request, env, ctx) {
      if (!ctx.auth.scope.includes("mcp:read")) {
        return insufficientScope(ctx.auth, ["mcp:read"]);
      }
      return mcpHandler(request, env, ctx);
    },
  },
});