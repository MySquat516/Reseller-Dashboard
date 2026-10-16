FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

CMD ["node", "server.js"]
