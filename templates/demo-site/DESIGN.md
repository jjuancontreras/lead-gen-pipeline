# Design — __BUSINESS_NAME__

> Google design.md format. Fill every value from the client's own photos and
> branding. **Do not copy a palette from a sibling project** — reuse the stack
> and the motion system, derive the visual system fresh.

## colors

Sampled from real photos via `npm run palette -- --slug __SLUG__`.
The sampler proposes; a human confirms contrast.

```yaml
bg:              "#ffffff"   # page background
bg-soft:         "#f5f5f4"   # alternating band
surface:         "#e7e5e4"   # cards, panels
surface-raised:  "#d6d3d1"   # raised cards
brand:           "#57534e"   # primary identity colour
brand-dim:       "#78716c"   # muted brand
accent:          "#44403c"   # secondary highlight
accent-warm:     "#78716c"   # warm highlight
text:            "#1c1917"   # body copy
text-dim:        "#57534e"   # muted copy
```

### contrast checks

Every pair below must clear **WCAG AA 4.5:1**. Record the measured ratio —
an unchecked row is not done.

| foreground | background | ratio | pass |
|---|---|---|---|
| text | bg | | |
| text-dim | bg | | |
| text | surface | | |
| brand | bg | | |

## typography

```yaml
display: ""   # headings — from next/font/google
body:    ""   # body copy
```

## motion

Inherited from the template: `AnimatedSection` scroll reveals,
`ParallaxImage` depth, `SiteLoader` entrance. Adjust intensity to suit the
brand; do not rebuild.

## voice

One or two lines on how this business talks about itself, in their own words
where possible. Quote the source.

## sources

| what | where it came from |
|---|---|
| photos | |
| menu | |
| hours | |
| palette | |
