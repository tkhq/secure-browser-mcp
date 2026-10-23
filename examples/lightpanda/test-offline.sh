#!/bin/sh
# Two containers, no network; only a disposable Unix socket directory is shared.
set -eu
image=${1:?usage: test-offline.sh LOCAL_IMAGE}
[ "$(id -u)" = 1000 ] || { echo 'This example requires Linux UID 1000.' >&2; exit 1; }
ipc_dir=$(mktemp -d /tmp/sbm-ipc.XXXXXX)
chmod 700 "$ipc_dir"
worker=sbm-worker-$(basename "$ipc_dir")
broker=sbm-probe-$(basename "$ipc_dir")
cleanup() {
  docker stop -t 3 "$broker" "$worker" >/dev/null 2>&1 || true
  rm -rf "$ipc_dir"
}
trap cleanup EXIT HUP INT TERM
run() {
  docker run --rm --init --pull=never --network=none --read-only --user=1000:1000 \
    --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128 \
    --memory=512m --cpus=1 --ulimit core=0 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777 "$@"
}
run -d --name "$worker" --mount "type=bind,src=$ipc_dir,dst=/ipc" \
  --entrypoint /usr/bin/env "$image" -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
  bun run test/lightpanda-worker-fixture.ts >/dev/null
for i in 1 2 3 4 5; do
  [ -S "$ipc_dir/browser.sock" ] && break
  sleep 1
done
# Bounded by the test's 30s timeout and the worker's independent 5-minute lease.
run --name "$broker" --mount "type=bind,src=$ipc_dir,dst=/ipc,readonly" \
  --entrypoint /usr/bin/env "$image" -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
  SBM_TEST_WORKER_SOCKET=/ipc/browser.sock bun test test/lightpanda-integration.test.ts
