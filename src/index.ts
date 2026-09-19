#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TasksApi } from './api.js';
import { loadConfig } from './config.js';
import { NextcloudClient } from './http.js';
import { dispatchTool, TOOLS } from './tools.js';
import { VERSION } from './version.js';

const config = loadConfig();
const client = new NextcloudClient(config);
const ctx = {
  api: new TasksApi(client, config.defaultTaskList),
  configSummary: `${config.url} as ${config.user}`,
};

const server = new Server(
  { name: 'tasks-mcp', version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) =>
  dispatchTool(req.params.name, req.params.arguments, ctx),
);

const transport = new StdioServerTransport();
await server.connect(transport);
