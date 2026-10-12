// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

import type { Request } from 'express'

/** Build the public origin seen by clients when Express sits behind nginx. */
export function requestPublicBaseUrl(req: Pick<Request, 'protocol' | 'get'>): string {
  const forwarded = req.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const protocol = forwarded === 'http' || forwarded === 'https' ? forwarded : req.protocol
  return `${protocol}://${req.get('host') ?? 'localhost'}`
}
