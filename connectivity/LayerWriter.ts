/*
 * Ported from KiCad source:
 *   pcbnew/plotter/plot_gerber.cpp (layer plotting)
 *   pcbnew/drill_writer.cpp (drill file text)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A layer writer that produces Gerber text for one board layer (tracks, pads,
 * vias, zones) from the board facade, plus the drill-file text from the
 * board's pad/via holes. Builds on GERBER (connectivity/gerber_export.ts) and
 * DRILL_LAYOUT (connectivity/drill_grid.ts).
 */

import { GERBER } from './GerberExport';
import { DRILL_LAYOUT } from './DrillGrid';
import type { KicadBoardFacade } from './KicadBoardFacade';
import { LayerName } from './LayerId';

/**
 * Writes a single copper layer's shapes to a GERBER emitter, given the board
 * facade and a target layer id (a copper layer 0..31).
 */
export function writeLayerGerber(
	aGerber: GERBER,
	aBoard: KicadBoardFacade,
	aLayer: number,
	aError = 0.005
): void {
	aGerber.Comment(`layer ${ LayerName(aLayer) }`);

	// Tracks (and arc tracks) on this layer.
	for (const t of aBoard.Tracks()) {
		if (t.GetLayer() === aLayer && t.toShape) {
			try {
				aGerber.Shape(t.toShape());
			} catch {
				// skip non-shapeable track
			}
		}
	}

	// Pads on this layer (flash their copper shape).
	for (const fp of aBoard.Footprints()) {
		for (const pad of fp.Pads()) {
			if (padTopLayer(pad) === aLayer || padBottomLayer(pad) === aLayer) {
				try {
					if (pad.toShape) {
						aGerber.Shape(pad.toShape());
					}
				} catch {
					// skip
				}
			}
		}
	}

	// Zones (outline region).
	for (const z of aBoard.Zones()) {
		try {
			if (z.toShape) {
				aGerber.Shape(z.toShape());
			}
		} catch {
			// skip
		}
	}
	void aError;
}

/** Extracts drill hits from every PTH pad/via on the board facade. */
export function collectDrillLayout(aBoard: KicadBoardFacade): DRILL_LAYOUT {
	const drill = new DRILL_LAYOUT();

	for (const fp of aBoard.Footprints()) {
		for (const pad of fp.Pads()) {
			const p = pad as any;
			const drillSize = typeof p.GetDrill === 'function' ? p.GetDrill() : 0;
			if (drillSize > 0 && typeof p.GetPosition === 'function') {
				drill.AddHole(p.GetPosition(), drillSize, p.GetNumber?.() ?? '');
			}
		}
	}

	for (const t of aBoard.Tracks()) {
		const tv = t as any;
		if (tv.Type?.() === 11 /* PCB_VIA_T */ &&
			typeof tv.GetDrillSize === 'function' &&
			typeof tv.GetPosition === 'function') {
			drill.AddHole(tv.GetPosition(), tv.GetDrillSize(), 'via');
		}
	}

	return drill;
}

/** Convenience: pad top/bottom copper layer id (best-effort). */
export function padTopLayer(pad: any): number {
	return pad.TopLayer ? pad.TopLayer() : 0;
}

/** Convenience: pad bottom copper layer id. */
export function padBottomLayer(pad: any): number {
	return pad.BottomLayer ? pad.BottomLayer() : 31;
}
