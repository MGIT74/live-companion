# Live Companion — produit (API CRM + interface vendeur), image Node 22
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/order-parser/package.json packages/order-parser/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY poc/meta-validation/package.json poc/meta-validation/
RUN npm ci --include=dev && npm cache clean --force

# Construction de l'interface (fichiers statiques)
FROM deps AS web
COPY apps/web ./apps/web
RUN npm run build -w apps/web

FROM deps
WORKDIR /app
COPY packages ./packages
COPY apps/api ./apps/api
COPY --from=web /app/apps/web/dist ./apps/web/dist
USER node
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:4000/health || exit 1
# Les migrations de base sont appliquées au démarrage.
CMD ["npm", "run", "start", "-w", "apps/api"]
