#!/bin/sh
set -eu

# Fail closed when an installation used --ignore-scripts (or a dependency
# layer was restored without our compatibility postinstall). Running an
# unpatched sync protocol is a correctness and capacity risk, not a supported
# degraded mode.
node /app/patch-automerge-peer-sync-state.mjs --check

asset_dir="${TECHNOLOGY_ASSET_DIR:-/var/lib/maplespire/assets/technologies}"
mkdir -p "$asset_dir"

# The image runs as uid 1000 (`node`) by default, which is what Kubernetes
# (fsGroup/CSI owns the mount) and ECS (EFS access point) use. A container
# started as root (`user: root`) can repair a volume another owner created;
# it then drops privileges to `node`.
if [ "$(id -u)" = "0" ]; then
  chown node:node "$asset_dir"
  chmod 0755 "$asset_dir"
  exec su-exec node "$@"
fi

if [ ! -w "$asset_dir" ]; then
  echo "technology asset directory is not writable by uid $(id -u): $asset_dir" >&2
  exit 1
fi
exec "$@"
