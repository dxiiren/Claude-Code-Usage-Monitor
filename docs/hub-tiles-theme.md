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

## A separate segment next to the traffic monitor

Put the hub tiles on their own taskbar surface so they sit by the TrafficMonitor tool instead of
after the accounts. Copy the strip surface, keep only the `hub-*` tiles, and change:

```json
{
  "id": "hub",
  "render": "(hub.layout.width > 0)",
  "placement": {
    "reference": { "region": "traffic_monitor", "display": 0 },
    "nest": "taskbar", "horizontal": "right", "vertical": "bottom",
    "surface_horizontal": "left", "surface_vertical": "bottom", "offset_x": 0, "offset_y": 0
  },
  "width": "max(1, hub.layout.width - 6)"
}
```

Tile `x` is just `hub.slot@n.x` (and `hub.overflow.x` for "+N"): there are no accounts before them.
`hub.layout.*` is computed for the free space next to the monitor, so the tiles step down from full
to compact to "+N" by themselves. The account strip keeps only its account tiles; its width is
`112 * accounts - 6`. On the taskbar the providers of one kind are already one tile (`hub.slotN`
is the Qwen group, `hub.qwen.*` by id), see the README.
