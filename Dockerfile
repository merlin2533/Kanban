# --- Build stage ---
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Production stage ---
FROM node:20-alpine

WORKDIR /app

# Copy only production node_modules (includes native better-sqlite3)
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server.js db.js email.js ./
COPY public/ ./public/
COPY uploads/.gitkeep ./uploads/

RUN mkdir -p /data

# Non-root user for security
RUN addgroup -S kanban && adduser -S kanban -G kanban
RUN chown -R kanban:kanban /app /data
USER kanban

ENV PORT=3000
ENV DB_PATH=/data/kanban.db
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
