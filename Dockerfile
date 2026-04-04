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

# Install bash and e2fsprogs for storage vault management
RUN apk add --no-cache bash e2fsprogs

WORKDIR /app

# Copy built assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy initialization script
COPY init-vault.sh /usr/local/bin/init-vault.sh
RUN chmod +x /usr/local/bin/init-vault.sh

# Environment defaults
ENV NODE_ENV=production
ENV API_URL=https://kyneto.app
ENV KUBO_API_URL=http://ipfs:5001

ENTRYPOINT ["/usr/local/bin/init-vault.sh"]
CMD ["node", "dist/index.js"]
