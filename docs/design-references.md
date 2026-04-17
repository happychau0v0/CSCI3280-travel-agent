# Design References

Visual and interaction references that informed the UI. Filed here
because they are not shipped behaviour, but reviewers should be able
to see where the menu shell and globe views came from.

## NieR: Automata menu shell

The chapter-selection / map-menu / pause screens in NieR: Automata
drove three core decisions:

1. **Monospaced, densely-framed panels** with a numbered tab strip
   (`1 PLAN`, `2 FLIGHTS`, `3 HOTELS`, `4 DAYS`, `5 EXPORT`) rather
   than a left-nav or tab header. Number-key navigation follows
   directly.
2. **Low-saturation palette** — cream foreground on washed-out
   grey / black, with a single accent per state. This lets photo
   content (hotel shots, Google Places thumbnails) carry the colour.
3. **Diegetic status** — the "AGENT WORKING" ticker and subtitle
   strip mimic the in-game system-message readouts instead of a
   spinner or modal.

| Reference | Informed |
|---|---|
| `references/Nier Chapter Selection.png` | Tab strip + numbered panels + chevron cursor |
| `references/Nier Map Menu.png` | PLAN panel layout (form block left, history right) |
| `references/Nier Menu 1.png` | SETTINGS / HELP overlay styling, confirmation row pattern |

## Zelda: Breath of the Wild map

| Reference | Informed |
|---|---|
| `references/zelda.png` | HOTELS / DAYS map — pinned markers with hover-on-peek metadata, vector polylines instead of raster routes |

## Flight visualisations and globe

The home-page globe (pre-plan) draws on open-source flight-tracking
aesthetics: a dark base map with backlit continent outlines and a
single emphasised arc / dest marker. Local iterations are kept in
`references/maplibre-globe/` (git-untracked; too many frames for
history) and are summarised here as a design note.

## Layout reference

| Reference | Informed |
|---|---|
| `references/layout_reference.jpg` | Detail-pane column proportions on DAYS and HOTELS — left list ≈ 38%, right detail ≈ 62%, no scrollbars at 1440 × 900 |

## Disclaimer

All referenced images are copyrighted by their respective owners and
are kept only as design inspiration material for an academic project.
No assets, trademarks, or trade dress from the referenced games or
services appear in the shipped product.
