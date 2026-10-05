FROM node:22-alpine AS build
WORKDIR /app

# Vite inlines import.meta.env.VITE_* into the bundle at build time, and
# .dockerignore keeps .env out of the build context. Without these two build
# args the image ships a bundle where the Google button always throws
# "Google sign-in is not configured." -- so they must be supplied at build time.
# The anon key is public by design; never pass SUPABASE_SERVICE_ROLE_KEY or
# the Google client secret here (those belong only in the runtime env / the
# Supabase dashboard respectively).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run verify
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 5050
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:5050/api/ready || exit 1
CMD ["node", "server/src/index.js"]
