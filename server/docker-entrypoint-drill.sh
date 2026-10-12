#!/bin/sh
set -eu

# The drill's entrypoint is NOT the api's.
#
# The api owns the technology-asset volume and repairs its ownership on a fresh
# named volume. The drill only READS that volume — it is mounted `:ro` on
# purpose, because a process whose job is to prove the data is recoverable must
# not be able to alter it — so the api's chown fails hard on the mount, and the
# `-w` check below would reject a correctly-configured container.
#
# What the drill does own is its bundle directory, and that one must be
# writable or every run fails at the first write with a less obvious message.

# Same fail-closed check as the api: an unpatched sync protocol would make the
# cold-API stage exercise a build nobody ships.
node /app/patch-automerge-peer-sync-state.mjs --check

backup_dir="${BACKUP_DIRECTORY:-/var/lib/maplespire/backups}"
mkdir -p "$backup_dir"

if [ "$(id -u)" = "0" ]; then
  chown node:node "$backup_dir"
  chmod 0755 "$backup_dir"
  exec su-exec node "$@"
fi

if [ ! -w "$backup_dir" ]; then
  echo "backup directory is not writable by uid $(id -u): $backup_dir" >&2
  exit 1
fi

exec "$@"
