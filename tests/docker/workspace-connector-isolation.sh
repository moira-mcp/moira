#!/bin/sh
set -eu

IMAGE_NAME=moira-workspace-connector-isolation-test
CONNECTOR_NAME=moira-workspace-connector-isolation-test
EGRESS_NAME=moira-workspace-egress-isolation-test
CONTROL_VOLUME=moira-workspace-connector-control-test
EGRESS_VOLUME=moira-workspace-connector-egress-test
TENANT_VOLUME=moira-workspace-other-tenant-test
PUBLIC_NETWORK=moira-workspace-connector-public-test

cleanup() {
  docker rm -f "$CONNECTOR_NAME" "$EGRESS_NAME" >/dev/null 2>&1 || true
  docker network rm "$PUBLIC_NETWORK" >/dev/null 2>&1 || true
  docker volume rm "$CONTROL_VOLUME" "$EGRESS_VOLUME" "$TENANT_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build --target runtime -t "$IMAGE_NAME" -f config/Dockerfile .
docker volume create "$CONTROL_VOLUME" >/dev/null
docker volume create "$EGRESS_VOLUME" >/dev/null
docker volume create "$TENANT_VOLUME" >/dev/null
docker network create "$PUBLIC_NETWORK" >/dev/null

# Materialize known other-tenant bytes and prove they exist from an authorized
# control mount. The connector never receives this volume.
docker run --rm \
  -v "$TENANT_VOLUME:/tenant-fixture" \
  --entrypoint /bin/sh \
  "$IMAGE_NAME" \
  -c 'umask 077; printf other-tenant-known-secret > /tenant-fixture/secret'
docker run --rm \
  -v "$TENANT_VOLUME:/tenant-fixture:ro" \
  --entrypoint /bin/sh \
  "$IMAGE_NAME" \
  -c 'test "$(cat /tenant-fixture/secret)" = other-tenant-known-secret'

docker run -d --name "$EGRESS_NAME" \
  --network "$PUBLIC_NETWORK" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 128m \
  --cpus 0.25 \
  -v "$EGRESS_VOLUME:/run/moira-workspace-egress" \
  --entrypoint /usr/local/bin/node \
  "$IMAGE_NAME" \
  --experimental-strip-types \
  /app/packages/web-backend/src/services/github-codespaces-egress-proxy.ts >/dev/null

docker run -d --name "$CONNECTOR_NAME" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --cap-add SETUID \
  --cap-add SETGID \
  --security-opt no-new-privileges:true \
  --init \
  --pids-limit 384 \
  --memory 640m \
  --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=536870912,mode=1777 \
  -v "$CONTROL_VOLUME:/run/moira-workspace-connector" \
  -v "$EGRESS_VOLUME:/run/moira-workspace-egress" \
  -e HTTPS_PROXY=http://127.0.0.1:18080 \
  -e HTTP_PROXY=http://127.0.0.1:18080 \
  -e NO_PROXY= \
  --entrypoint /usr/local/bin/node \
  "$IMAGE_NAME" \
  --experimental-strip-types \
  /app/packages/web-backend/src/services/github-codespaces-connector-server.ts >/dev/null

attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$CONNECTOR_NAME" \
    curl --fail --silent --unix-socket /run/moira-workspace-connector/connector.sock \
    http://localhost/health | grep -q '"state":"available"'; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
test "$attempt" -lt 30

# The credential-bearing connector has only loopback and two narrow Unix sockets.
test "$(docker inspect "$CONNECTOR_NAME" --format '{{.HostConfig.NetworkMode}}')" = "none"
test "$(docker inspect "$CONNECTOR_NAME" --format '{{.HostConfig.ReadonlyRootfs}}')" = "true"
test "$(docker inspect "$CONNECTOR_NAME" --format '{{.HostConfig.PidsLimit}}')" = "384"
# The init process reaps gh/ssh helpers that jobs leave behind, so they cannot pile up as zombies.
test "$(docker inspect "$CONNECTOR_NAME" --format '{{.HostConfig.Init}}')" = "true"
docker exec "$CONNECTOR_NAME" sh -c 'test "$(cat /proc/1/comm)" = "docker-init"'
test "$(docker inspect "$CONNECTOR_NAME" --format '{{.HostConfig.Memory}}')" = "671088640"
# Every connector process except the minimal init reaper runs as the unprivileged user.
test "$(docker top "$CONNECTOR_NAME" -eo pid,user,comm | tail -n +2 | grep -v ' docker-init$' | awk '{print $2}' | sort -u)" = "1000"
! docker inspect "$CONNECTOR_NAME" --format '{{range .Mounts}}{{println .Name}}{{end}}' |
  grep -qx "$TENANT_VOLUME"

# Direct attempts at Moira control/data, another tenant, the Docker socket,
# private/host space and cloud metadata all fail inside the connector.
docker exec "$CONNECTOR_NAME" test ! -e /app/data/moira.db
docker exec "$CONNECTOR_NAME" test ! -e /tenant-fixture/secret
docker exec "$CONNECTOR_NAME" test ! -S /var/run/docker.sock
! docker exec "$CONNECTOR_NAME" curl --noproxy '*' --fail --max-time 2 http://moira:3001/health
! docker exec "$CONNECTOR_NAME" curl --noproxy '*' --fail --max-time 2 http://172.17.0.1/
! docker exec "$CONNECTOR_NAME" curl --noproxy '*' --fail --max-time 2 http://169.254.169.254/latest/meta-data/

# The single provider route remains usable through the credential-free proxy.
docker exec "$CONNECTOR_NAME" curl --fail --silent --max-time 20 https://api.github.com/meta >/dev/null
! docker exec "$CONNECTOR_NAME" curl --fail --silent --max-time 5 https://example.com/

echo workspace-connector-isolation-ok
