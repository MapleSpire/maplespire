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

export const LEGAL_VERSION = '2026-08-02'

export function legalDocumentUrls(language: string | null | undefined): {
  terms: string
  privacy: string
} {
  const locale = language?.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  return {
    terms: `https://maplespire.ca/${locale}/termsofservice/`,
    privacy: `https://maplespire.ca/${locale}/privacystatement/`,
  }
}
