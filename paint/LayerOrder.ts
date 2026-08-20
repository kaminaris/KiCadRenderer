// Canonical bottom-to-top paint order for KiCad PCB layers — derived from
// kicanvas's ViewLayerSet (board/layers.ts's LayerNames enum defines
// "front to back" add() order; view-layers.ts's in_display_order() proves
// via the WebGL depth assignment in viewer.ts — depth increases per layer
// and GL_GREATER wins — that layers added *earlier* get *lower* depth,
// i.e. paint bottom-to-top is the REVERSE of that add() order). This is not
// a guess: it's read off their actual source, since they've already solved
// getting this right for a real KiCad-accurate renderer.
//
// One global fixed order — this is the ONE place layer stacking is decided.
// No per-element-type sort hacks; that's what produced the "weave" bug.
export const layerPaintOrder: string[] = [
	// Back-side non-copper (drawn first = bottommost)
	'B.Fab', 'B.CrtYd', 'B.Paste', 'B.Adhes', 'B.SilkS', 'B.Mask',
	// Pads are NOT a separate layer in real KiCad — they're part of their
	// copper layer (B.Cu/F.Cu) and BoardPainter.build() appends them to
	// that same bucket, after tracks/zones, so they naturally paint on top
	// within it. No 'B.Pads'/'F.Pads' entries here.
	'B.Cu',
	// Inner copper, back-to-front (In30 nearest B.Cu, In1 nearest F.Cu)
	'In30.Cu', 'In29.Cu', 'In28.Cu', 'In27.Cu', 'In26.Cu', 'In25.Cu',
	'In24.Cu', 'In23.Cu', 'In22.Cu', 'In21.Cu', 'In20.Cu', 'In19.Cu',
	'In18.Cu', 'In17.Cu', 'In16.Cu', 'In15.Cu', 'In14.Cu', 'In13.Cu',
	'In12.Cu', 'In11.Cu', 'In10.Cu', 'In9.Cu', 'In8.Cu', 'In7.Cu',
	'In6.Cu', 'In5.Cu', 'In4.Cu', 'In3.Cu', 'In2.Cu', 'In1.Cu',
	// Front-side non-copper
	'F.Fab', 'F.CrtYd', 'F.Paste', 'F.Adhes', 'F.SilkS', 'F.Mask',
	'F.Cu',
	// Documentation/reference layers, drawn on top of the physical board
	'User.9', 'User.8', 'User.7', 'User.6', 'User.5', 'User.4', 'User.3',
	'User.2', 'User.1', 'Margin', 'Edge.Cuts', 'Eco2.User', 'Eco1.User',
	'Cmts.User', 'Dwgs.User',
	// Non-layer synthetic bucket this painter uses (always drawn last/on top)
	'Vias',
	// Pad number overlay (KiCad footprint-editor style) — above copper/vias
	// so numbers stay readable on filled pads.
	'PadNumbers',
];

const rankByLayer = new Map(layerPaintOrder.map((name, idx) => [name, idx]));

/** Unknown/unrecognized layers sort before everything else (bottommost), rather than crashing. */
export function layerPaintRank(layer: string): number {
	return rankByLayer.get(layer) ?? -1;
}

// Real KiCad's Layers PANEL display order — a genuinely different sequence
// from layerPaintOrder above, confirmed against the real KiCad source
// (`C:\Projects\Personal\Electronic\kicad`), not assumed: `LSET::UIOrder()`
// (common/lset.cpp) = `CuStack()` + `TechAndUserUIOrder()`, and that's
// exactly what `pcbnew/widgets/appearance_controls.cpp`'s Layers tab
// iterates to build its own row list. Using layerPaintOrder (bottom-to-top
// WebGL/Canvas paint z-order) for the sidebar Appearance panel's row order
// was a real bug — every non-copper layer landed in a different slot than
// real KiCad's own panel — see kicad-viewer-layer-panel-order memory.
//
// `CuStack()`: F.Cu first, then inner layers front-to-back (In1→In30), then
// B.Cu last — confirmed by reading `LSET::copper_layers_iterator::
// next_copper_layer()` (common/lset.cpp) directly: it special-cases F_Cu to
// jump straight to In1_Cu (skipping B_Cu, layer index 2, entirely on the
// first step) and only visits B_Cu once every inner layer is exhausted —
// NOT a naive walk of the raw PCB_LAYER_ID enum value order (which would
// visit B_Cu=2 right after F_Cu=0, before any inner layer).
//
// `TechAndUserUIOrder()`: technical layers paired front-then-back BY
// FUNCTION (Adhes, Paste, SilkS, Mask), then the six fixed doc/reference
// layers, then Courtyard/Fab pairs, then generic User.N layers ascending —
// a completely different grouping from layerPaintOrder's "all of one
// side's technicals, then (after all the copper) all of the other side's".
export const layerPanelOrder: string[] = [
	'F.Cu',
	'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'In5.Cu', 'In6.Cu', 'In7.Cu', 'In8.Cu', 'In9.Cu', 'In10.Cu',
	'In11.Cu', 'In12.Cu', 'In13.Cu', 'In14.Cu', 'In15.Cu', 'In16.Cu', 'In17.Cu', 'In18.Cu', 'In19.Cu', 'In20.Cu',
	'In21.Cu', 'In22.Cu', 'In23.Cu', 'In24.Cu', 'In25.Cu', 'In26.Cu', 'In27.Cu', 'In28.Cu', 'In29.Cu', 'In30.Cu',
	'B.Cu',
	'F.Adhes', 'B.Adhes', 'F.Paste', 'B.Paste', 'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask',
	'Dwgs.User', 'Cmts.User', 'Eco1.User', 'Eco2.User', 'Edge.Cuts', 'Margin',
	'F.CrtYd', 'B.CrtYd', 'F.Fab', 'B.Fab',
	'User.1', 'User.2', 'User.3', 'User.4', 'User.5', 'User.6', 'User.7', 'User.8', 'User.9',
];
