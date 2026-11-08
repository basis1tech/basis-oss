# Runs the basis1 MCP server (@basis1/mcp) over stdio, built from this
# repository. Used by MCP directories that build servers from source (Glama),
# and by anyone who'd rather self-host than run `npx -y @basis1/mcp`.
#
#   docker build -t basis1-mcp .
#   docker run -i --rm -e BASIS_API_KEY=... basis1-mcp
#
# The server starts and lists its tools without BASIS_API_KEY; calling a tool
# needs a key (free at https://basis1.tech/settings).
FROM node:22-slim AS build
WORKDIR /app

# The MCP server depends on the SDK through file:../sdk, so build the SDK first.
COPY sdk/package.json sdk/package-lock.json sdk/
RUN cd sdk && npm ci
COPY sdk/ sdk/
RUN cd sdk && npm run build

COPY mcp/package.json mcp/package-lock.json mcp/
RUN cd mcp && npm ci
COPY mcp/ mcp/
RUN cd mcp && npm run build && npm prune --omit=dev && cd ../sdk && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/sdk/package.json sdk/
COPY --from=build /app/sdk/dist sdk/dist
COPY --from=build /app/sdk/node_modules sdk/node_modules
COPY --from=build /app/mcp/package.json mcp/
COPY --from=build /app/mcp/dist mcp/dist
COPY --from=build /app/mcp/node_modules mcp/node_modules
USER node
ENTRYPOINT ["node", "mcp/dist/index.js"]
