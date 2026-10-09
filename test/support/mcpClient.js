// @ts-check
/**
 * The official MCP TypeScript client (a devDependency of this package), re-exported so tests outside
 * agent/ (the editor repository's test/agent-mcp.test.mjs) resolve it from agent/node_modules.
 */
export { Client, InMemoryTransport } from '@modelcontextprotocol/client'
export { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
