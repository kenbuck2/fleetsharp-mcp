import express from "express";
import fetch from "node-fetch";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
const PORT = process.env.PORT || 8080;

// Pull secrets from Cloud Run environment
const FLEET_HOST = process.env.FLEET_HOST;
const FLEET_TOKEN = process.env.FLEET_TOKEN;
const CONNECTOR_TOKEN = process.env.CONNECTOR_TOKEN;

// Basic health check (for curl/browser)
app.get("/health", (req, res) => {
  res.json({ status: "ok", fleetHost: FLEET_HOST ? "set" : "missing" });
});

// Auth middleware for connector calls
function checkAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (CONNECTOR_TOKEN && auth === `Bearer ${CONNECTOR_TOKEN}`) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
}

// Example FleetSharp call wrapper
async function fleetGet(path, params = {}) {
  const url = new URL(path, FLEET_HOST);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined) url.searchParams.set(k, v);
  });

  const r = await fetch(url.href, {
    headers: { Authorization: `Bearer ${FLEET_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Fleet API error: ${r.status}`);
  return r.json();
}

// Set up MCP server with SSE transport
const server = new McpServer({ name: "fleetsharp-mcp", version: "1.0.0" });

server.registerTool(
  "list_vehicles",
  { title: "List vehicles", description: "Get all vehicles", inputSchema: {} },
  async () => {
    const data = await fleetGet("/api/vehicles"); // adjust endpoint to your docs
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

server.registerTool(
  "vehicle_last_location",
  {
    title: "Last known location",
    description: "Get last known GPS point",
    inputSchema: { deviceId: z.string() },
  },
  async ({ deviceId }) => {
    const data = await fleetGet(`/api/vehicles/${deviceId}/last-location`);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

server.registerTool(
  "events",
  {
    title: "Vehicle events",
    description: "Ignition, speeding, idling, etc.",
    inputSchema: {
      start: z.string(),
      end: z.string(),
      deviceId: z.string().optional(),
    },
  },
  async ({ start, end, deviceId }) => {
    const data = await fleetGet("/api/events", { start, end, deviceId });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// SSE handler for ChatGPT connector
const transports = {};
app.get("/sse", checkAuth, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post("/messages", checkAuth, async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(400).send("No transport");
  await transport.handlePostMessage(req, res, req.body);
});

// Start Express
app.listen(PORT, () => {
  console.log(`FleetSharp MCP server running on port ${PORT}`);
});
