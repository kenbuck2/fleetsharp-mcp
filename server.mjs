// server.mjs
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Env: set these in your host (Render/Fly/Cloud Run/etc.)
const FLEET_HOST = process.env.FLEET_HOST;      // e.g. https://<your-account-host>
const FLEET_TOKEN = process.env.FLEET_TOKEN;    // Linxup/FleetSharp API token
const CONNECTOR_TOKEN = process.env.CONNECTOR_TOKEN; // Secret your connector will send

const app = express();
app.use(express.json());

// Simple gate so randos can’t open a session
function requireConnectorAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  if (CONNECTOR_TOKEN && hdr !== `Bearer ${CONNECTOR_TOKEN}`) {
    return res.status(401).send("Unauthorized");
  }
  next();
}

// Helper to call Linxup/FleetSharp
async function fsGet(path, params = {}) {
  const url = new URL(path, FLEET_HOST);
  Object.entries(params).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));
  const r = await fetch(url.href, { headers: { Authorization: `Bearer ${FLEET_TOKEN}` } });
  if (!r.ok) throw new Error(`Fleet API ${r.status}`);
  return r.json();
}

// Build MCP server and tools
import { z as zod } from "zod";
const server = new McpServer({ name: "fleetsharp-mcp", version: "1.0.0" });

// Tool: list vehicles
server.registerTool(
  "list_vehicles",
  { title: "List vehicles", description: "Return vehicles in the account", inputSchema: {} },
  async () => {
    // Replace with your real endpoint from Linxup docs
    const data = await fsGet("/api/vehicles");
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// Tool: last location for a device
server.registerTool(
  "last_location",
  {
    title: "Last known location",
    description: "Get last GPS point for a device",
    inputSchema: { deviceId: zod.string() }
  },
  async ({ deviceId }) => {
    const data = await fsGet(`/api/vehicles/${deviceId}/last-location`);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// Tool: events/trips in a time window
server.registerTool(
  "events",
  {
    title: "Events by time window",
    description: "Ignition, speeding, idling, etc.",
    inputSchema: {
      start: zod.string(), // ISO 8601
      end: zod.string(),
      deviceId: zod.string().optional()
    }
  },
  async ({ start, end, deviceId }) => {
    const data = await fsGet(`/api/events`, { start, end, deviceId });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// Legacy SSE transport (what the UI expects: /sse + /messages)
const transports = {};
app.get("/sse", requireConnectorAuth, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post("/messages", requireConnectorAuth, async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(400).send("No transport for session");
  await transport.handlePostMessage(req, res, req.body);
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`FleetSharp MCP on ${PORT}`));
