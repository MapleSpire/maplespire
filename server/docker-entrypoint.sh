#!/bin/sh
set -eu

# Fail closed when an installation used --ignore-scripts (or a dependency
# layer was restored without our compatibility postinstall). Running an
# unpatched sync protocol is a correctness and capacity risk, not a supported
# degraded mode.
node /app/patch-automerge-peer-sync-state.mjs --check

asset_dir="${TECHNOLOGY_ASSET_DIR:-/var/lib/maplespire/assets/technologies}"
mkdir -p "$asset_dir"

# Compose starts this image as root so a fresh named volume can be repaired
# before privileges are dropped. Kubernetes starts it directly as uid 1000;
# in that mode fsGroup/CSI owns the mount and chown is neither needed nor
# permitted by the restricted Pod Security profile.
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
