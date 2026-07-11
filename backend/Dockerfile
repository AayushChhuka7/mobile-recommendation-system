FROM node:20-alpine

WORKDIR /app

# Install deps (cached layer)
COPY package*.json ./
RUN npm install

# Copy backend source
COPY . .

# Generate the Prisma client (writes to src/generated/prisma)
RUN npx prisma generate

EXPOSE 8001

# Default: run the API. The db-init service overrides this with its own
# one-shot command (schema push + RBAC seed + bulk CSV import).
# The GSMArena CSV is bind-mounted into /seed at runtime by docker-compose
# (see the db-init service), so import-gsmarena-bulk.mjs reads from there.
CMD ["npm", "run", "dev"]