# Creating a theme plugin

This guide shows how to build a **community theme** for the diagram canvas. A
theme is a small TypeScript module that draws the canvas your way — boxes,
connections, groups, backgrounds — using the **Theme SDK**.

You can write and publish one entirely in the app: **Item Shop → Community →
Create theme**. The editor compiles your code, runs it in a live preview, and
publishes it to the gallery.

---

## How themes run (and why it's safe)

- **Official themes** (Clean, Neon City, 8‑Bit, Street Sketch) run on the main
  thread for speed.
- **Community themes run sandboxed.** Your code executes in a hardened Web
  Worker that draws to an overlay canvas. It has **no access** to the network
  (`fetch`/`WebSocket`/…), storage (`localStorage`/`indexedDB`), the DOM, or
  other tabs — those are removed before your code runs. If a theme hangs or
  throws, a watchdog disables it and the canvas reverts to the default theme.
  The only thing you can do is draw.

That means: be self‑contained, keep each frame cheap, and don't expect to load
anything external.

---

## The shape of a theme

```ts
import { defineTheme } from '@theme/sdk'

export default defineTheme({
  meta: {
    id: 'community:yourname:blueprint', // community:<author>:<slug>
    name: 'Blueprint',
    version: '1.0.0',                    // semver
    trust: 'community',
    sdkVersion: '1.0.0',                 // SDK you target
  },

  // Optional draw hooks (any subset). See "Seams" below.
  object: {
    mode: 'replace',
    draw(d, a) { /* draw object `a` with surface `d` */ },
  },
})
```

`defineTheme` validates the shape and returns the theme. The editor wraps the
`import` / `export default` for you, so just author a normal module.

---

## Seams (the hooks you can implement)

The engine renders the diagram in a fixed order and calls your matching hook at
each **seam**. Implement only the ones you need.

| Seam | Space | What it draws |
|---|---|---|
| `background` | screen | the canvas backdrop (behind everything) |
| `grid` | world | the dotted grid |
| `group` | world | group containers |
| `connectionLine` | world | connection curves |
| `object` | world | the object boxes |
| `connectionOverlay` | world | arrowheads / anchors on top of lines |
| `selection` | world | per‑item decoration drawn after content (e.g. brackets) |
| `screenOverlay` | screen | a screen‑space overlay on top (e.g. scan lines) |

Each hook has a **mode**:

- `'replace'` — you own this primitive; the engine **skips** its default. Use
  this for a full reskin.
- `'pre'` — draw **before** the engine's default (underneath it).
- `'post'` — draw **after** the engine's default (on top).

```ts
object: {
  mode: 'replace',
  draw(d, a) { /* ... */ },
}
```

> In a community theme, a `replace` hook makes the engine suppress its own base
> primitive so your overlay owns those pixels. World‑space hooks are drawn with
> the live pan/zoom already applied — use world coordinates from `a`.

---

## The drawing surface `d`

`d` is a Canvas‑2D‑like surface. Common calls:

```ts
d.save(); d.restore()
d.beginPath(); d.moveTo(x, y); d.lineTo(x, y); d.closePath()
d.rect(x, y, w, h); d.roundRect(x, y, w, h, r); d.arc(cx, cy, r, a0, a1)
d.bezierCurveTo(c1x, c1y, c2x, c2y, x, y)
d.fill(); d.stroke(); d.clip()
d.fillRect(x, y, w, h); d.fillText(text, x, y)
d.translate(x, y); d.rotate(rad); d.scale(sx, sy)
d.setLineDash([5, 4])
d.fillStyle = '#38bdf8'; d.strokeStyle = '#7dd3fc'; d.lineWidth = 2
d.globalAlpha = 0.5; d.shadowColor = '#000'; d.shadowBlur = 8
d.font = '600 12px monospace'; d.textAlign = 'center'; d.textBaseline = 'middle'
const g = d.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, '#000')
```

Only safe colors are accepted (hex/`rgb()`/`hsl()` and a few keywords) — no
`url()`/`image-set()`.

---

## What each hook receives (`a`)

Every hook gets a `ctx` (the per‑frame `RenderContext`) plus item data.

`ctx`:

```ts
ctx.timeMs       // monotonic time for animation
ctx.fastMode     // true while panning/zooming — SKIP heavy work when true
ctx.viewport     // { x, y, scale }
ctx.canvas       // { width, height } in CSS px
ctx.rng(seedKey) // deterministic PRNG factory (stable per key)
```

`object` hook — `a`:

```ts
a.id; a.type; a.name
a.geom   // { x, y, w, h, cornerRadius, cx, cy }
a.state  // { selected, hovered, external, ... }
```

`connectionLine` / `connectionOverlay` — `a`:

```ts
a.from   // source object edge point  { x, y }
a.to     // target object edge point  { x, y }  ← put arrowheads here
a.bezierAt(t) // point on the curve, t in [0,1]
a.state  // { hovered, highlighted, ... }
```

`group` — `a`: `a.geom` (`x,y,w,h,cornerRadius`), `a.isParentWrapper`, `a.state`.

---

## Animation

Return per‑frame values from `animate(timeMs)`; they appear on `ctx.anim`. Keep
`isAnimating()` honest so the canvas can idle when nothing moves.

```ts
isAnimating() { return true },
animate(t) { return { pulse: 1 + Math.sin(t / 500) * 0.2 } },
object: {
  mode: 'replace',
  draw(d, a) { d.globalAlpha = a.ctx.anim.pulse ?? 1; /* ... */ },
}
```

Heavy effects must **no‑op when `ctx.fastMode` is true** (during interaction),
or the watchdog may disable your theme.

---

## Example: a "blueprint" reskin

```ts
import { defineTheme } from '@theme/sdk'

export default defineTheme({
  meta: { id: 'community:demo:blueprint', name: 'Blueprint', version: '1.0.0', trust: 'community', sdkVersion: '1.0.0' },

  object: {
    mode: 'replace',
    draw(d, a) {
      const g = a.geom
      d.save()
      d.fillStyle = a.state.selected ? 'rgba(56,189,248,0.32)' : 'rgba(15,42,99,0.6)'
      d.strokeStyle = '#38bdf8'
      d.lineWidth = 2
      d.beginPath(); d.rect(g.x, g.y, g.w, g.h); d.fill(); d.stroke()
      d.fillStyle = '#e0f2fe'
      d.font = '600 12px monospace'
      d.textAlign = 'center'; d.textBaseline = 'middle'
      d.fillText(a.name, g.x + g.w / 2, g.y + g.h / 2)
      d.restore()
    },
  },

  connectionLine: {
    mode: 'replace',
    draw(d, a) {
      d.save()
      d.strokeStyle = '#1d4ed8'; d.lineWidth = 1.5; d.setLineDash([5, 4])
      d.beginPath()
      const p0 = a.bezierAt(0); d.moveTo(p0.x, p0.y)
      for (let t = 0.05; t <= 1.0001; t += 0.05) { const p = a.bezierAt(t); d.lineTo(p.x, p.y) }
      d.lineTo(a.to.x, a.to.y); d.stroke()
      // arrowhead aligned to the final approach
      const end = a.bezierAt(1)
      const ang = Math.atan2(a.to.y - end.y, a.to.x - end.x)
      const L = 9, s = 0.45
      d.setLineDash([]); d.beginPath()
      d.moveTo(a.to.x, a.to.y)
      d.lineTo(a.to.x - L * Math.cos(ang - s), a.to.y - L * Math.sin(ang - s))
      d.lineTo(a.to.x - L * Math.cos(ang + s), a.to.y - L * Math.sin(ang + s))
      d.closePath(); d.fillStyle = '#1d4ed8'; d.fill()
      d.restore()
    },
  },
})
```

---

## Publishing & versioning

- Publish from **Item Shop → Community → Create theme → Publish**. Your theme is
  stored in the gallery and becomes installable by others.
- Bump `meta.version` (semver) to publish an update; installers see “update
  available”.
- `meta.sdkVersion` is the SDK you built against — keep it current so the app
  knows your theme is compatible.

---

## Checklist

- [ ] `id` is `community:<author>:<slug>`
- [ ] Only `import { defineTheme } from '@theme/sdk'` (no other imports)
- [ ] No `fetch`/DOM/storage — you can't use them anyway
- [ ] Heavy passes guarded by `if (ctx.fastMode) return`
- [ ] Arrowheads drawn at `a.to`
- [ ] Looks right in the editor's live preview before publishing
