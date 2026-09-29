# Hosted broker (src/http.ts). See docs/HOSTED.md before deploying.
#
# By default the image runs session browsers on Browserbase and holds no
# Chrome. Build with --build-arg LOCAL_CHROME=true to run Chrome in the
# container instead; that needs a seccomp profile that allows user
# namespaces (docs/HOSTED.md, "Local Chrome in a container").
FROM oven/bun:1-debian

ARG LOCAL_CHROME=false
RUN if [ "$LOCAL_CHROME" = "true" ]; then \
    apt-get update \
    && apt-get install -y --no-install-recommends chromium chromium-sandbox fonts-liberation \
    && rm -rf /var/lib/apt/lists/*; \
  fi

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY tsconfig.json ./

ENV SBM_BROWSER=browserbase \
    SBM_CHROME_PATH=/usr/bin/chromium \
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
