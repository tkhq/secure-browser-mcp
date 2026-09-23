# Hosted broker (src/http.ts). See docs/HOSTED.md before deploying.
FROM oven/bun:1-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium chromium-sandbox fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY tsconfig.json ./

# Chrome keeps its sandbox: the container must allow unprivileged user
# namespaces (see docs/HOSTED.md). /dev/shm is small in most containers.
ENV SBM_CHROME_PATH=/usr/bin/chromium \
    SBM_CHROME_ARGS=--disable-dev-shm-usage \
    SBM_HEADLESS=true \
    SBM_HTTP_HOST=0.0.0.0 \
    SBM_HTTP_PORT=8080 \
    SBM_STATE_DIR=/var/lib/sbm

RUN mkdir -p /var/lib/sbm && chown bun:bun /var/lib/sbm
USER bun
VOLUME /var/lib/sbm
EXPOSE 8080
CMD ["bun", "src/http.ts"]
