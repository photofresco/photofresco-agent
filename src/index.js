// @ts-check
/**
 * PhotoFresco local connector: the shared in-process API behind the MCP server, the CLI and
 * the JSON-RPC stdio endpoint. See CONNECTOR.md (API and security model) and DISCLOSURE.md
 * (what it runs, sends and fetches).
 */
export { CONNECT_LIMITS, CONNECTOR_NAME, CONNECTOR_VERSION, Connector, DEFAULT_EDITOR_URL, SURFACES, createConnector } from './connector.js'
export { CONNECTOR_ERROR_CODES, ConnectorError } from './errors.js'
export { FILE_LIMITS } from './files.js'
export { CHANNEL_PROTOCOL } from './page.js'
export { MIN_BROWSER_MAJOR, browserCandidates, defaultDataDir, findBrowser } from './browser.js'
