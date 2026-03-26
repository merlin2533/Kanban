FROM node:20-alpine

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY . .

# Create data and uploads directories
RUN mkdir -p /data uploads

ENV PORT=3000
ENV DB_PATH=/data/kanban.db
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
