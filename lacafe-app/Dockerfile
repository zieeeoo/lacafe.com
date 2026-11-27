FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY data/seed.json ./seed/seed.json
ENV NODE_ENV=production TRUST_PROXY=1 PORT=3000 DATA_DIR=/app/data
RUN chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
