#!/usr/bin/env bash
# docker_smoke.sh — build the server image and prove it boots correctly on a Linux runner
# Called by: .gitea/workflows/ci.yml → docker (Build image + smoke run)
# Process:   push + PR — after web-unit; the last gate before merge
# Interface: env: TAG (unique image tag), NAME (unique container name), NODE_IMAGE (base image) | outputs: none
#
# The job container reaches the host Docker daemon through its socket, so the smoke container
# is a SIBLING: `-p 127.0.0.1:...` would publish on the runner host, not in this job. Attach it
# to the job's own network and call it by container IP instead.
# Server mode rejects any Host header except ACCTMGR_PUBLIC_ORIGIN's (DNS-rebinding guard,
# web/src/lib/server/guard.ts), so curl sends Host 127.0.0.1:47291 and connects to the IP
# with --connect-to.
set -eu

: "${TAG:?TAG required}" "${NAME:?NAME required}" "${NODE_IMAGE:?NODE_IMAGE required}"
PORT=47291
ORIGIN="http://127.0.0.1:${PORT}"

echo "=== docker build (NODE_IMAGE=${NODE_IMAGE})"
docker build --pull --build-arg "NODE_IMAGE=${NODE_IMAGE}" -t "$TAG" web

echo "=== refuses to start without ACCTMGR_ADMIN_PASSWORD"
if out=$(docker run --rm "$TAG" 2>&1); then
  echo "$out"; echo "::error::image started without a password"; exit 1
fi
echo "$out"
echo "$out" | grep -q 'ACCTMGR_ADMIN_PASSWORD is required' || { echo "::error::exited, but not for the missing password"; exit 1; }

echo "=== boot with a password"
docker rm -f "$NAME" >/dev/null 2>&1 || true
JOB_NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(hostname)" 2>/dev/null | awk '{print $1}' || true)
NET_ARGS=()
[ -n "$JOB_NET" ] && NET_ARGS=(--network "$JOB_NET")
echo "network: ${JOB_NET:-<daemon default>}"
docker run -d --name "$NAME" "${NET_ARGS[@]}" --memory=1g \
  -e ACCTMGR_ADMIN_PASSWORD=ci-only-password -e "ACCTMGR_PUBLIC_ORIGIN=${ORIGIN}" "$TAG"
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME")
[ -n "$IP" ] || { echo "::error::container has no IP"; docker logs "$NAME" 2>&1 | tail -50; exit 1; }
CURL=(curl --noproxy '*' -s --connect-to "127.0.0.1:${PORT}:${IP}:${PORT}")

code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "${ORIGIN}$1" || true; }

ready=false
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || { echo "::error::container exited"; docker logs "$NAME" 2>&1 | tail -50; exit 1; }
  [ "$(code /healthz)" = "200" ] && { ready=true; break; }
  sleep 1
done
[ "$ready" = "true" ] || { echo "::error::/healthz never returned 200"; docker logs "$NAME" 2>&1 | tail -50; exit 1; }

check() {
  got=$(code "$1")
  echo "GET $1 -> $got (want $2)"
  [ "$got" = "$2" ]
}
check /healthz 200
check / 303
check /api/v1/widget 401
docker exec "$NAME" claude --version
echo "=== smoke OK"
