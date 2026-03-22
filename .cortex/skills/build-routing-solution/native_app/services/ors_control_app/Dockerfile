FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build && npm run build:server

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
EXPOSE 3001
CMD ["node", "dist-server/index.js"]
