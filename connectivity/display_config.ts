/*
 * Ported from KiCad source:
 *   libs/kimath/... display options (EDA_DRAW_MODE / LSET visibility)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Display configuration: the draw mode (sketch/filled/outline) for an item and
 * layer-visibility helpers. Mirrors KiCad's EDA_DRAW_MODE and LSET::Contains
 * visibility concepts.
 */

import { LSET } from './ConnectivityItems';

/** Mirrors EDA_DRAW_MODE. */
export enum DRAW_MODE {
	SKETCH = 0,
	FILLED = 1,
	OUTLINE = 2,
}

/** Whether a layer is visible in a given visible-layer set. */
export function isLayerVisible(aVisibleLayers: LSET, aLayer: number): boolean {
	return aVisibleLayers.Contains(aLayer);
}

/** Toggles a layer's visibility in a visible-layer set. */
export function setLayerVisible(aVisibleLayers: LSET, aLayer: number, aVisible: boolean): LSET {
	const out = aVisibleLayers.Clone();
	if (aVisible) {
		out.SetLayer(aLayer);
	} else {
		out.RmLayerSet(aLayer);
	}
	return out;
}

/** Default: all copper + the key technical layers visible. */
export function defaultVisibleLayers(): LSET {
	return new LSET().AllCuMask();
}

/** The draw mode used for a filled item by default (filled). */
export function defaultDrawMode(): DRAW_MODE {
	return DRAW_MODE.FILLED;
}
