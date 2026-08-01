# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (layer cache)
COPY package*.json ./

# Install ALL deps (including dev for tsc)
RUN npm install --frozen-lockfile

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/
RUN npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Copy only production deps
COPY package*.json ./
RUN npm install --omit=dev --frozen-lockfile

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Expose port (Railway sets PORT env var)
EXPOSE 3001

CMD ["node", "dist/index.js"]
