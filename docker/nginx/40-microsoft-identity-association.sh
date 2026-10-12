#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Olivier Albertini
#
# This file is part of MapleSpire.
# MapleSpire is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# MapleSpire is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.

# Microsoft Entra publisher-domain verification, OFF by default.
#
# Entra verifies a publisher domain by fetching
# /.well-known/microsoft-identity-association.json from it. Set
# MS_IDENTITY_ASSOCIATION_APP_ID to the application (client) ID of your app
# registration to serve that file; leave it empty and nginx answers 404.
#
# Run by the official nginx entrypoint (/docker-entrypoint.d) before nginx
# starts, so the file always matches the current container environment.

set -eu

# Overridable for tests only; nginx serves /usr/share/nginx/html.
target_dir="${MS_IDENTITY_ASSOCIATION_DIR:-/usr/share/nginx/html/.well-known}"
target="$target_dir/microsoft-identity-association.json"
app_id="${MS_IDENTITY_ASSOCIATION_APP_ID:-}"

if [ -z "$app_id" ]; then
  rm -f "$target"
  exit 0
fi

if ! printf '%s' "$app_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
  echo "$0: MS_IDENTITY_ASSOCIATION_APP_ID must be an application (client) ID GUID; not serving the association file" >&2
  rm -f "$target"
  exit 0
fi

mkdir -p "$target_dir"
printf '{\n  "associatedApplications": [\n    {\n      "applicationId": "%s"\n    }\n  ]\n}\n' "$app_id" > "$target"
echo "$0: serving Microsoft identity association for application $app_id"
