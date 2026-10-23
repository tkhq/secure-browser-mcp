# Build context is an allowlisted export of this repository plus a verified binary.
FROM oven/bun@sha256:53710ce0f14eef8312521c586a7ae1d9aeab4011840f09f1966073b68fc2e2ab
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY test/lightpanda-integration.test.ts test/lightpanda-worker-fixture.ts test/lightpanda-lifecycle.test.ts ./test/
COPY scripts/probe-lightpanda-worker.ts ./scripts/probe-lightpanda-worker.ts
COPY lightpanda /usr/local/bin/lightpanda
RUN echo 'aa5a4b8ed53d1e38b3c73f5b2647d0a84a82e6744557f45f9a9c85858aa031c3  /usr/local/bin/lightpanda' | sha256sum -c - && chmod 0555 /usr/local/bin/lightpanda
USER 1000:1000
ENTRYPOINT ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "bun", "run", "src/worker/lightpanda.ts"]
CMD ["/ipc/browser.sock"]
