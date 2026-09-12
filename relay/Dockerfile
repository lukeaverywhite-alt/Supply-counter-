FROM node:24-alpine
WORKDIR /app
COPY relay/server.mjs ./relay/server.mjs
USER node
EXPOSE 8787
CMD ["node", "relay/server.mjs"]
