# PoC Live Companion — image Node 22
FROM node:22-alpine

WORKDIR /app

# Dépendances (workspaces npm) — couche mise en cache
COPY package.json package-lock.json ./
COPY packages/order-parser/package.json packages/order-parser/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY poc/meta-validation/package.json poc/meta-validation/
RUN npm ci --include=dev && npm cache clean --force

# Code
COPY packages ./packages
COPY poc ./poc

# Données et preuves persistées dans un volume (voir docker-compose.yml)
RUN mkdir -p poc/meta-validation/data poc/meta-validation/evidence && chown -R node:node poc/meta-validation
USER node

ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["npm", "run", "start", "-w", "poc/meta-validation"]
