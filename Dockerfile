# The PhotoFresco MCP server over stdio, built from this repository's source (pf-agent-platform-nkwn.35).
#
#   docker build -t photofresco-mcp .
#   docker run -i --rm photofresco-mcp
#
# For MCP registries that start the server in a container and list its tools (Glama). Nothing is
# installed: the server has no runtime dependencies (the MCP SDK is bundled in vendor/). The image
# contains no browser, so photofresco_connect fails here with browser_not_found; to edit images, run
# the server on your own computer as the README describes. Starting it and listing tools opens nothing
# and makes no network request.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
COPY vendor ./vendor

ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "src/bin/photofresco.js", "mcp"]
