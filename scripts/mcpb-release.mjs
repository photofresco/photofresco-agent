// Pure release names and URLs, shared by the bundle builder and registry checks.
export const REPO = 'https://github.com/photofresco/photofresco-agent'

/** File name of the bundle for `version`: the GitHub Release asset name. @param {string} version */
export const mcpbFileName = (version) => `photofresco-mcp-${version}.mcpb`
/** Where the release `v<version>` serves the bundle (server.json's mcpb package identifier). @param {string} version */
export const mcpbReleaseUrl = (version) => `${REPO}/releases/download/v${version}/${mcpbFileName(version)}`
