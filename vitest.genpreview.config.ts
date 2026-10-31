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

import { defineConfig } from 'vitest/config'
import base from './vitest.config'

// `npm run gen:layout-preview`: the layout SVG preview generator
// (src/lib/layout/genPreview.tool.ts) with the test config's transforms, and
// nothing else. It used to sit in the test suite as a permanently skipped file.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/lib/layout/genPreview.tool.ts'],
  },
})
