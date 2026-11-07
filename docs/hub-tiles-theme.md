# Agent Hub tiles in a theme

A theme draws hub providers once and repeats the drawing. This is the whole pattern for the
compact taskbar strip; the floating card is the same with the `x`/`y` lines noted at the end.

```json
{
  "id": "hub-name-dark-@n",
  "name": "hub name dark @n",
  "repeat": 12,
  "render": "(hub.slot@n.shown) * (system.dark)",
  "x": "((accounts.claude.a.shown + accounts.claude.b.shown) * (view.rows > 0)) * 112 + hub.slot@n.x",
  "y": "1",
  "width": "hub.layout.tile_w - 6",
  "height": "15",
  "content": { "type": "text", "template": "{hub.slot@n.name}", "font_size": "10", "weight": "bold" }
}
```

1. `repeat` makes 12 copies, `@n` becomes the copy number (1 to 12) in every string.
2. `hub.slot@n.shown` is 1 only for the N-th ticked provider that fits, so unused copies draw nothing.
3. The value rows use `(1 - hub.layout.compact)` (two lines `.line1`, `.line2`) or
   `hub.layout.compact` (one line `.short`) in `render`.
4. Add `hub.overflow.shown` / `hub.overflow.text` (`+3`) / `hub.overflow.x` for the "+N" tile.
5. Surface width: `112 * accounts + hub.layout.width - 6`.

Floating card: put the hub row under the accounts. `x = 12 + hub.slot@n.x`,
`y = 62 * A + 8 * (1 - A) + hub.slot@n.row * 46 + offset` where `A` is 1 when the account row is
shown, and height `62 * A + 46 * hub.layout.rows + (hub.layout.rows > 0) * (16 - 8 * A)`.

Variables: `hub.slotN.{shown,name,text,line1,line2,short,percent,has_percent,up,has_up,x,row}`,
`hub.layout.{tile_w,compact,fit,overflow,rows,per_row,width}`, `hub.overflow.{shown,x,text}`,
`hub.shown_count`, and `hub.<id>.*` for a provider by its id.
