FROM node:20-bookworm-slim

WORKDIR /app
# package-lock.json mitkopieren + npm ci: jeder Build nutzt exakt die getesteten Versionen
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js backup.js auth.js ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Der Entrypoint startet als root nur kurz (Rechte auf /data) und wechselt dann auf den Benutzer "node".
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
