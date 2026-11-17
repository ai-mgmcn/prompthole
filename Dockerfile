# PromptHole has no runtime dependencies, so the image is just Node plus the source.
FROM node:26-alpine
WORKDIR /app
COPY package.json rules.default.json server.mjs ./
COPY src ./src
COPY lib ./lib
COPY public ./public

# Inside a container PromptHole must listen on all interfaces; keep it private by publishing the port to 127.0.0.1 only
# (see docker-compose.yml). Data (rules, logs) lives in the /data volume.
ENV PROMPTHOLE_HOST=0.0.0.0 PROMPTHOLE_PORT=8787 PROMPTHOLE_DATA=/data NODE_ENV=production
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD node -e "fetch('http://127.0.0.1:8787/api/stats').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
