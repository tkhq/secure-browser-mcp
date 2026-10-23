#!/bin/sh
# External orchestration owns crash/expiry tests; broker has no runtime socket.
set -eu
image=${1:?usage: test-lifecycle.sh LOCAL_IMAGE}
[ "$(id -u)" = 1000 ] || exit 1
ipc_dir=$(mktemp -d /tmp/sbm-lifecycle.XXXXXX)
chmod 700 "$ipc_dir"
worker=sbm-worker-$(basename "$ipc_dir")
broker=sbm-probe-$(basename "$ipc_dir")
cleanup() {
  docker rm -f "$broker" "$worker" >/dev/null 2>&1 || true
  rm -rf "$ipc_dir"
}
trap cleanup EXIT HUP INT TERM
run() {
  docker run --init --pull=never --network=none --read-only --user=1000:1000 \
    --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128 \
    --memory=512m --cpus=1 --ulimit core=0 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777 "$@"
}
for mode in expiry crash; do
  lifetime=300000
  [ "$mode" != expiry ] || lifetime=4000
  run -d --name "$worker" --mount "type=bind,src=$ipc_dir,dst=/ipc" \
    --entrypoint /usr/bin/env "$image" -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
    bun run test/lightpanda-worker-fixture.ts "$lifetime" >/dev/null
  for i in 1 2 3 4 5; do
    [ -S "$ipc_dir/browser.sock" ] && break
    sleep 1
  done
  run -d --name "$broker" --mount "type=bind,src=$ipc_dir,dst=/ipc,readonly" \
    --entrypoint /usr/bin/env "$image" -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
    SBM_TEST_LIFECYCLE_SOCKET=/ipc/browser.sock bun test test/lightpanda-lifecycle.test.ts >/dev/null
  if [ "$mode" = crash ]; then
    ready=false
    for i in 1 2 3 4 5 6 7 8 9 10; do
      case "$(docker logs "$broker" 2>&1)" in *WORKER_ATTACHED*) ready=true; break;; esac
      sleep 1
    done
    [ "$ready" = true ] || exit 1
    docker kill "$worker" >/dev/null
  fi
  status=$(docker wait "$broker")
  docker logs "$broker"
  [ "$status" = 0 ] || exit 1
  docker rm -f "$broker" "$worker" >/dev/null
  # Only our disposable socket; an abrupt kill leaves it behind.
  rm -f "$ipc_dir/browser.sock"
  echo "PASS: $mode"
done
