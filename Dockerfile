# The hosted web app: one container that serves the exported Expo web bundle
# and the API it calls (sync, AI proxy and Anki import) from the same origin.
# Sync data lives in Postgres: reference a Railway Postgres service as
# DATABASE_URL on this service.
#
# Built by Railway (see railway.json); works with any Docker host. Firebase
# client config is baked into the bundle at build time, so the EXPO_PUBLIC_*
# values must be set as build-time variables. GEMINI_API_KEY is read only at
# runtime and never reaches the bundle.

FROM node:26-slim

WORKDIR /app

# Install first, from manifests only, so a source change reuses this layer.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --no-audit --no-fund

COPY . .

# Public Firebase web config (browser-safe; used only for sign-in).
ARG EXPO_PUBLIC_FLUENTFLOW_FIREBASE_API_KEY
ARG EXPO_PUBLIC_FLUENTFLOW_FIREBASE_AUTH_DOMAIN
ARG EXPO_PUBLIC_FLUENTFLOW_FIREBASE_PROJECT_ID
ARG EXPO_PUBLIC_FLUENTFLOW_FIREBASE_STORAGE_BUCKET
ARG EXPO_PUBLIC_FLUENTFLOW_FIREBASE_MESSAGING_SENDER_ID
ARG EXPO_PUBLIC_FLUENTFLOW_FIREBASE_APP_ID
# Railway passes the deployed commit to builds that declare it. It is shown in
# Settings and published with the desktop bundle manifest.
ARG RAILWAY_GIT_COMMIT_SHA

RUN npm run build -w @fluentflow/core \
  && EXPO_PUBLIC_FLUENTFLOW_API_BASE_URL=same-origin EXPO_PUBLIC_FLUENTFLOW_SYNC_URL=same-origin \
     EXPO_PUBLIC_FLUENTFLOW_COMMIT=${RAILWAY_GIT_COMMIT_SHA} \
     NODE_ENV=production npm run web:export

ENV NODE_ENV=production
# The server needs the project id to verify sign-in tokens; reuse the build value.
ENV EXPO_PUBLIC_FLUENTFLOW_FIREBASE_PROJECT_ID=${EXPO_PUBLIC_FLUENTFLOW_FIREBASE_PROJECT_ID}
ENV FLUENTFLOW_COMMIT=${RAILWAY_GIT_COMMIT_SHA}

EXPOSE 8787
CMD ["node", "apps/server/src/index.ts"]
