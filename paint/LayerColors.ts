export interface LayerStyle {
	color: string;
	// Default opacity for this layer. Copper layers are opaque by default —
	// matching real KiCad, where ordinary copper (tracks, pads, vias) is
	// solid. The translucent look copper boards have in KiCad comes
	// specifically from ZONE (area/pour) fills, which KiCad renders with
	// their own reduced opacity regardless of the layer's own opacity —
	// see ZONE_FILL_ALPHA below, applied directly in BoardPainter's
	// buildZone() rather than through this per-layer setting. An earlier
	// version of this file applied translucency to the whole copper LAYER
	// instead, which made tracks/pads translucent too — not what real KiCad
	// does, and not what was intended by "let zone fills show what's
	// underneath".
	opacity: number;
}

// Zone (copper pour) fills always render at this opacity, independent of
// whatever the layer's own opacity slider is set to (the two multiply
// together, so lowering the layer slider still dims zones further — this
// is just the zone's own baseline, matching how real KiCad visually
// distinguishes "this is a filled area" from solid copper).
export const zoneFillAlpha = 0.55;

// Colors lifted directly from a real KiCad 10 color theme export
// (colors/user.json's "board" section) rather than approximated — same rgb()
// strings KiCad itself uses, valid as-is for canvas fillStyle/strokeStyle.
// Opacity for translucent layers (mask/paste) also comes from that file's
// rgba() alpha; copper keeps an intentional extra translucency (see above).
const layerStyles: Record<string, LayerStyle> = {
	'F.Cu': { color: 'rgb(200, 52, 52)', opacity: 1 },
	'In1.Cu': { color: 'rgb(127, 200, 127)', opacity: 1 },
	'In2.Cu': { color: 'rgb(206, 125, 44)', opacity: 1 },
	'In3.Cu': { color: 'rgb(79, 203, 203)', opacity: 1 },
	'In4.Cu': { color: 'rgb(219, 98, 139)', opacity: 1 },
	'In5.Cu': { color: 'rgb(167, 165, 198)', opacity: 1 },
	'In6.Cu': { color: 'rgb(40, 204, 217)', opacity: 1 },
	'In7.Cu': { color: 'rgb(232, 178, 167)', opacity: 1 },
	'In8.Cu': { color: 'rgb(242, 237, 161)', opacity: 1 },
	'In9.Cu': { color: 'rgb(141, 203, 129)', opacity: 1 },
	'In10.Cu': { color: 'rgb(237, 124, 51)', opacity: 1 },
	'In11.Cu': { color: 'rgb(91, 195, 235)', opacity: 1 },
	'In12.Cu': { color: 'rgb(247, 111, 142)', opacity: 1 },
	'In13.Cu': { color: 'rgb(167, 165, 198)', opacity: 1 },
	'In14.Cu': { color: 'rgb(40, 204, 217)', opacity: 1 },
	'In15.Cu': { color: 'rgb(232, 178, 167)', opacity: 1 },
	'In16.Cu': { color: 'rgb(242, 237, 161)', opacity: 1 },
	'In17.Cu': { color: 'rgb(237, 124, 51)', opacity: 1 },
	'In18.Cu': { color: 'rgb(91, 195, 235)', opacity: 1 },
	'In19.Cu': { color: 'rgb(247, 111, 142)', opacity: 1 },
	'In20.Cu': { color: 'rgb(167, 165, 198)', opacity: 1 },
	'In21.Cu': { color: 'rgb(40, 204, 217)', opacity: 1 },
	'In22.Cu': { color: 'rgb(232, 178, 167)', opacity: 1 },
	'In23.Cu': { color: 'rgb(242, 237, 161)', opacity: 1 },
	'In24.Cu': { color: 'rgb(237, 124, 51)', opacity: 1 },
	'In25.Cu': { color: 'rgb(91, 195, 235)', opacity: 1 },
	'In26.Cu': { color: 'rgb(247, 111, 142)', opacity: 1 },
	'In27.Cu': { color: 'rgb(167, 165, 198)', opacity: 1 },
	'In28.Cu': { color: 'rgb(40, 204, 217)', opacity: 1 },
	'In29.Cu': { color: 'rgb(232, 178, 167)', opacity: 1 },
	'In30.Cu': { color: 'rgb(242, 237, 161)', opacity: 1 },
	'B.Cu': { color: 'rgb(77, 127, 196)', opacity: 1 },

	'F.SilkS': { color: 'rgb(242, 237, 161)', opacity: 1 },
	'B.SilkS': { color: 'rgb(232, 178, 167)', opacity: 1 },
	'F.Mask': { color: 'rgb(216, 100, 255)', opacity: 0.4 },
	'B.Mask': { color: 'rgb(2, 255, 238)', opacity: 0.4 },
	'F.Paste': { color: 'rgb(180, 160, 154)', opacity: 0.902 },
	'B.Paste': { color: 'rgb(0, 194, 194)', opacity: 0.902 },
	'F.Adhes': { color: 'rgb(132, 0, 132)', opacity: 1 },
	'B.Adhes': { color: 'rgb(0, 0, 132)', opacity: 1 },
	'F.CrtYd': { color: 'rgb(255, 38, 226)', opacity: 1 },
	'B.CrtYd': { color: 'rgb(38, 233, 255)', opacity: 1 },
	'F.Fab': { color: 'rgb(175, 175, 175)', opacity: 0.8 },
	'B.Fab': { color: 'rgb(88, 93, 132)', opacity: 0.8 },
	'Edge.Cuts': { color: 'rgb(208, 210, 205)', opacity: 1 },
	'Margin': { color: 'rgb(255, 38, 226)', opacity: 1 },
	'Dwgs.User': { color: 'rgb(194, 194, 194)', opacity: 1 },
	'Cmts.User': { color: 'rgb(89, 148, 220)', opacity: 1 },
	'Eco1.User': { color: 'rgb(180, 219, 210)', opacity: 1 },
	'Eco2.User': { color: 'rgb(216, 200, 82)', opacity: 1 },
	// User.1-User.9 (board.user_1..user_9 in the theme file) — these were
	// previously falling through to DEFAULT_STYLE's flat gray, which is
	// exactly why dimensions on User.4 (a common KiCad default for
	// dimension annotations) didn't visually match their real color.
	'User.1': { color: 'rgb(194, 194, 194)', opacity: 1 },
	'User.2': { color: 'rgb(89, 148, 220)', opacity: 1 },
	'User.3': { color: 'rgb(180, 219, 210)', opacity: 1 },
	'User.4': { color: 'rgb(216, 200, 82)', opacity: 1 },
	'User.5': { color: 'rgb(194, 194, 194)', opacity: 1 },
	'User.6': { color: 'rgb(89, 148, 220)', opacity: 1 },
	'User.7': { color: 'rgb(180, 219, 210)', opacity: 1 },
	'User.8': { color: 'rgb(216, 200, 82)', opacity: 1 },
	'User.9': { color: 'rgb(194, 194, 194)', opacity: 1 },

	// Real KiCad has no separate "pads" layer/color — pads are drawn in
	// whatever color their host copper layer uses. Kept only as a fallback
	// in case some caller still asks for it; BoardPainter no longer buckets
	// pads under these keys (see the F.Pads/B.Pads removal from LayerOrder).
	'Vias': { color: 'rgb(236, 236, 236)', opacity: 1 },
	// Synthetic overlay for pad numbers (contrast on red/blue copper).
	'PadNumbers': { color: 'rgb(236, 236, 236)', opacity: 1 },
};

const defaultStyle: LayerStyle = { color: 'rgb(144, 144, 144)', opacity: 0.7 };

// Real KiCad board background (colors/user.json board.background) — used
// both for the canvas clear color and to "punch" via holes so the hole
// visually matches whatever's actually behind it.
export const boardBackgroundColor = 'rgb(0, 16, 35)';

// colors/user.json board.via_hole_walls / board.via_hole — the plated
// barrel and the drilled bore itself, both fixed (never net-colored),
// unlike the via's own outer annular ring which takes the color of
// whichever copper layer it's flashed on (see BoardPainter.buildVia).
export const viaHoleWallColor = 'rgb(236, 236, 236)';
export const viaHoleColor = 'rgb(227, 183, 46)';

export function styleForLayer(layer: string): LayerStyle {
	return layerStyles[layer] ?? defaultStyle;
}

export function colorForLayer(layer: string): string {
	return styleForLayer(layer).color;
}

/** Rewrites a 'rgb(r,g,b)' or '#rrggbb'/'#rgb' color into 'rgba(r,g,b,alpha)'
 * — used to bake a fixed alpha into a color string (e.g. ZONE_FILL_ALPHA for
 * zone fills) independent of whatever opacity the renderer backend applies
 * on top via the current layer's own opacity setting. */
export function withAlpha(color: string, alpha: number): string {
	if (color.startsWith('#')) {
		let hex = color.slice(1);
		if (hex.length === 3) {
			hex = hex.split('').map(c => c + c).join('');
		}
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		return `rgba(${ r }, ${ g }, ${ b }, ${ alpha })`;
	}
	const match = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)/);
	if (match) {
		return `rgba(${ match[1] }, ${ match[2] }, ${ match[3] }, ${ alpha })`;
	}
	return color;
}
