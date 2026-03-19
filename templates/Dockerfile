FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && rm -rf /root/.npm
COPY server.mjs ./

ENV MCP_TRANSPORT=http
ENV PORT=8787
EXPOSE 8787

USER node
CMD ["node", "server.mjs"]
