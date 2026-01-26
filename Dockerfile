# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy source code and TypeScript config
COPY src ./src
COPY tsconfig.json ./

# Build the daemon
RUN npm run build

# Stage 2: Production
FROM node:18-alpine

WORKDIR /app

# Copy built assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Environment defaults
ENV NODE_ENV=production
ENV API_URL=http://api.incentivelayer.io
ENV KUBO_API_URL=http://ipfs:5001

CMD ["node", "dist/index.js"]
