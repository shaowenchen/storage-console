FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
COPY scripts ./scripts
RUN apk add --no-cache python3 make g++
RUN npm ci
RUN npm --prefix web ci

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

RUN npm run build
RUN test -f dist/public/index.html

FROM node:22-alpine AS runner
WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
ENV SKIP_WEB_POSTINSTALL=1
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev \
  && apk del python3 make g++ \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN test -f dist/public/index.html

EXPOSE 3001
CMD ["node", "dist/index.js"]
