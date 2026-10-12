# Theme tokens & migration map

The app supports **light** and **dark** themes. Colors are driven by CSS custom
properties defined in `src/index.css`: the `@theme` block holds the light values,
and `:root[data-theme='dark']` overrides them. The active theme is set on
`<html data-theme="…">` by `src/stores/themeStore.ts`.

**Rule:** chrome (sidebars, top bar, modals, tables, panels, menus) must use the
semantic **token utilities** below — never hard-coded slate/blue hexes — so it
reskins automatically. Light token values equal the old literals, so migrating is
visually identical in light mode.

## Mapping: old literal → token utility

### Surfaces (backgrounds)
| Old | New |
| --- | --- |
| `bg-white`, `bg-[#FFFFFF]`, `bg-[#fff]` | `bg-surface-100` |
| `bg-[#F8FAFC]` (incl. `hover:bg-[#F8FAFC]`) | `bg-surface-50` |
| `bg-[#F1F5F9]` (incl. `hover:`) | `bg-surface-200` |
| `bg-[#E2E8F0]` (block fill) | `bg-surface-300` |
| `bg-[#E2E8F0]` (1px `w-px`/`h-px` divider bar) | `bg-line` |
| `bg-[#CBD5E1]` | `bg-surface-400` |
| `bg-[#EFF6FF]`, `bg-[#DBEAFE]` (selected/active blue) | `bg-accent-subtle` |
| `bg-[#0F172A]` (dark chip/button) | `bg-inverse` |
| `bg-[#1E293B]` | `bg-inverse-hover` |
| `bg-black/30`, `bg-black/40` (modal backdrop) | keep as-is |

### Text
| Old | New |
| --- | --- |
| `text-[#0F172A]`, `text-[#1E293B]` | `text-fg` |
| `text-[#334155]` | `text-fg-strong` |
| `text-[#475569]` | `text-fg-secondary` |
| `text-[#64748B]` | `text-fg-muted` |
| `text-[#94A3B8]`, `text-[#CBD5E1]` | `text-fg-subtle` |
| `text-[#3B82F6]` | `text-accent` |
| `text-[#2563EB]` | `text-accent-hover` |
| `text-white` on `bg-inverse`/`bg-[#0F172A]`/`bg-[#1E293B]` | `text-on-inverse` |
| `text-white` on accent/semantic colored bg | keep `text-white` |

### Borders / rings
| Old | New |
| --- | --- |
| `border-[#E2E8F0]`, `border-[#F1F5F9]` | `border-line` |
| `border-[#CBD5E1]` | `border-line-strong` |
| `border-[#3B82F6]` | `border-accent` |
| `border-[#2563EB]` | `border-accent-hover` |
| `ring-[#3B82F6]`, `focus:ring-[#3B82F6]` | `ring-accent` |

### Semantic (status, comments, badges)
Map status/semantic chrome colors to semantic tokens (each has a strong color, a
soft `-bg`, and a readable `-text`):
| Meaning | Strong | Soft bg | Text-on-soft |
| --- | --- | --- | --- |
| success/green/live | `*-success` | `bg-success-bg` | `text-success-text` |
| warning/amber | `*-warning` | `bg-warning-bg` | `text-warning-text` |
| error/red/down | `*-error` | `bg-error-bg` | `text-error-text` |
| info/blue | `*-info` | `bg-info-bg` | `text-info-text` |
| violet/purple | `*-violet` | `bg-violet-bg` | `text-violet-text` |

Examples: `bg-red-50 text-red-600` → `bg-error-bg text-error-text`;
`#EF4444` notification dot → `bg-error`; `#22C55E` → `bg-success`;
`#8B5CF6`/`#7C3AED`/`#EDE9FE` → violet tokens.

### Prefix-aware replacements
A substring replace on the bracket part is usually safe because the utility
prefix is preserved, e.g. replacing `bg-[#F8FAFC]`→`bg-surface-50` also fixes
`hover:bg-[#F8FAFC]`→`hover:bg-surface-50`, `group-hover:`, `active:`, etc.

## DO NOT touch (intentional colors)
- **Brand/tech colors** — e.g. `TechIconBadge` technology brand hexes (`#61DAFB`,
  `#339933`, …), domain colors.
- **Canvas/skin rendering colors** — anything passed to a 2D canvas context or
  read from a `SkinConfig` (the diagram itself is themed by skins, not tokens).
- **Rarity colors** (`rarityColors`).
- Non-color classes, layout, spacing, logic, `data-testid`s.

When a literal isn't in the table, pick the closest token by role (background vs
text vs border) and lightness. If it's a brand/canvas color, leave it.
