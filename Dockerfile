FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY src ./src
COPY openapi ./openapi
COPY scripts ./scripts
ENV NODE_ENV=production
USER node
EXPOSE 3000
# API: `npm run start:prod` applies migrations then starts. Worker: override with `node src/workers/index.js`.
CMD ["npm", "run", "start:prod"]
