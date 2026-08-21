/*
 * Ported from KiCad source:
 *   pcbnew/plot_layer_iterator.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * PLOT_LAYER_ITERATOR — iterates over the set of copper + technical layers to
 * plot/print, in KiCad's layered order (each copper layer, then silkscreen /
 * mask / paste / fab as configured). Mirrors KiCad's plot layer iterator.
 */

import { LSET } from './ConnectivityItems';
import { TECHNICAL_LAYER, IsCuLayer, LayerName } from './LayerId';

/** A plotted layer: the copper/technical id plus its label. */
export interface PLOT_LAYER {
	id: number;
	name: string;
	isCopper: boolean;
}

/**
 * Iterates over a set of layers in plot order. Mirrors KiCad's
 * PLOT_LAYER_ITERATOR: copper layers in stack order, then any technical layers
 * requested.
 */
export class PLOT_LAYER_ITERATOR {
	// The ordered list of layers to produce.
	private m_layers: PLOT_LAYER[] = [];
	private m_index = 0;

	/**
	 * @param aCopperLayers the copper layer set to plot (e.g. all enabled).
	 * @param aTechnical the technical layer ids to include after the copper.
	 */
	constructor(aCopperLayers?: LSET, aTechnical: number[] = []) {
		if (aCopperLayers) {
			// KiCad plots copper in CuStack order (internal -> B -> F).
			for (const l of aCopperLayers.CuStack()) {
				this.m_layers.push({ id: l, name: LayerName(l), isCopper: true });
			}
		} else {
			// Default: all copper + the given technical.
			const all = new LSET().AllCuMask();
			for (const l of all.CuStack()) {
				this.m_layers.push({ id: l, name: LayerName(l), isCopper: true });
			}
		}
		for (const t of aTechnical) {
			this.m_layers.push({ id: t, name: LayerName(t), isCopper: false });
		}
	}

	/** True if more layers remain. */
	More(): boolean {
		return this.m_index < this.m_layers.length;
	}

	/** Advances to the next layer, returning it (or null when done). */
	Next(): PLOT_LAYER | null {
		if (this.m_index >= this.m_layers.length) {
			return null;
		}
		return this.m_layers[this.m_index++]!;
	}

	Layers(): PLOT_LAYER[] {
		return this.m_layers;
	}

	Reset(): void {
		this.m_index = 0;
	}
}

/**
 * Builds the typical default plot set: copper (all) + Edge.Cuts + both
 * silk/mask/paste.
 */
export function defaultPlotLayers(): PLOT_LAYER_ITERATOR {
	return new PLOT_LAYER_ITERATOR(new LSET().AllCuMask(), [
		TECHNICAL_LAYER.Edge_Cuts,
		TECHNICAL_LAYER.F_SilkS,
		TECHNICAL_LAYER.B_SilkS,
		TECHNICAL_LAYER.F_Mask,
		TECHNICAL_LAYER.B_Mask,
		TECHNICAL_LAYER.F_Paste,
		TECHNICAL_LAYER.B_Paste,
	]);
}

/** Whether a layer id is a copper layer (convenience). */
export function isCopper(aLayerId: number): boolean {
	return IsCuLayer(aLayerId);
}

/** Technical layers subset used for a typical plot. */
export const COMMON_PLOT_TECHNICAL_LAYERS: number[] = [
	TECHNICAL_LAYER.Edge_Cuts,
	TECHNICAL_LAYER.F_SilkS,
	TECHNICAL_LAYER.B_SilkS,
	TECHNICAL_LAYER.F_Mask,
	TECHNICAL_LAYER.B_Mask,
	TECHNICAL_LAYER.F_Paste,
	TECHNICAL_LAYER.B_Paste,
];
