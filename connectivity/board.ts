/*
 * Ported from KiCad source:
 *   pcbnew/board.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A BOARD model wrapping the parsed board AST, exposing the KiCad BOARD item
 * surface the connectivity port and painters consume: Zones / Tracks /
 * Footprints / Drawings / GetNetInfo, footprint lookup, design settings, and
 * the board outline polygon. The per-item adapters come from the shared
 * KicadBoardFacade.
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { SHAPE_LINE_CHAIN } from '../geometry/ShapeLineChain';
import { buildBoardFacadeFromAst, KicadBoardFacade, AstAdapter } from './KicadBoardFacade';
import { NETINFO_LIST } from './netinfo';
import { LSET, PCB_LAYER_ID } from './ConnectivityItems';
import type { LayeredBoardScene } from '../paint/BoardPainter';

/**
 * A BOARD. `aRootElement` is the parsed `(kicad_pcb ...)` root; `aScene` is
 * the renderer scene (used by the facade for zone fill / layer data).
 */
export class BOARD {
	private m_rootElement: any;
	private m_scene: LayeredBoardScene;
	private m_facade: KicadBoardFacade;
	private m_netInfo = new NETINFO_LIST();
	private m_boardOutline: SHAPE_POLY_SET = new SHAPE_POLY_SET();

	constructor(aRootElement: any, aScene: LayeredBoardScene) {
		this.m_rootElement = aRootElement;
		this.m_scene = aScene;
		this.m_facade = buildBoardFacadeFromAst(aRootElement, aScene);
		this.buildNetInfo();
		this.buildBoardOutline();
	}

	Zones(): AstAdapter[] {
		return this.m_facade.Zones();
	}

	Tracks(): AstAdapter[] {
		return this.m_facade.Tracks();
	}

	Footprints(): AstAdapter[] {
		return this.m_facade.Footprints();
	}

	Drawings(): AstAdapter[] {
		return this.m_facade.Drawings();
	}

	GetEnabledLayers(): LSET {
		return this.m_facade.GetEnabledLayers();
	}

	/** The board's net list (net code -> name). */
	GetNetInfo(): NETINFO_LIST {
		return this.m_netInfo;
	}

	GetRootElement(): any {
		return this.m_rootElement;
	}

	/** Mirrors BOARD::FindFootprintByReference. */
	FindFootprintByReference(aReference: string): AstAdapter | null {
		for (const fp of this.m_facade.Footprints()) {
			const el = fp.Element();
			const ref = this.footprintReference(el);
			if (ref === aReference) {
				return fp;
			}
		}
		return null;
	}

	private footprintReference(el: any): string {
		for (const p of el?.children ?? []) {
			if (p?.name === 'property' && p?.key === 'Reference') {
				return p.value ?? '';
			}
		}
		return el?.Reference?.Value ?? '';
	}

	/** Mirrors BOARD::FindFootprintByPath (best-effort by uuid). */
	FindFootprintByUuid(aUuid: string): AstAdapter | null {
		for (const fp of this.m_facade.Footprints()) {
			const el = fp.Element();
			if (el?.getUuid && (el.getUuid() as string) === aUuid) {
				return fp;
			}
		}
		return null;
	}

	/** Mirrors BOARD::GetDesignSettings — minimal bridge to the AST setup. */
	GetDesignSettings(): any {
		return this.m_rootElement?.findFirstChildByName?.('setup') ?? null;
	}

	/** Board bounding box (from all items). */
	GetBoundingBox(): { x: number; y: number; w: number; h: number } {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const z of this.m_facade.Zones()) {
			const b = z.GetBoundingBox();
			minX = Math.min(minX, b.x);
			minY = Math.min(minY, b.y);
			maxX = Math.max(maxX, b.x2);
			maxY = Math.max(maxY, b.y2);
		}
		for (const t of this.m_facade.Tracks()) {
			const b = t.GetBoundingBox();
			minX = Math.min(minX, b.x);
			minY = Math.min(minY, b.y);
			maxX = Math.max(maxX, b.x2);
			maxY = Math.max(maxY, b.y2);
		}
		if (!Number.isFinite(minX)) {
			return { x: 0, y: 0, w: 0, h: 0 };
		}
		return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
	}

	/** The board outline polygon built from Edge.Cuts graphics. */
	GetBoardPolygonOutlines(): SHAPE_POLY_SET {
		return this.m_boardOutline;
	}

	/**
	 * Builds the board-outline polygon from the root element's Edge.Cuts
	 * graphics (fp_shapes / gr_* / fp_line on Edge.Cuts). Mirrors KiCad's
	 * BOARD::GetBoardPolygonOutlines using a simple closed chain of the
	 * outline points. This is a best-effort port; true KiCad uses
	 * BuildBoardPolygonOutlines + ConvertOutlineToPolygon.
	 */
	private buildBoardOutline(): void {
		const pts: Vec2[] = [];
		const collect = (el: any): void => {
			if (!el) {
				return;
			}
			if (el.name === 'fp_line' || el.name === 'gr_line' || el.name === 'segment') {
				const layers = el.getLayers ? el.getLayers(this.m_scene.copperLayerStack) : [];
				if (layers.includes('Edge.Cuts')) {
					const { start, end } = el.getStartEnd ? el.getStartEnd() : { start: null, end: null };
					if (start && end) {
						pts.push(new Vec2(start.x, start.y));
						pts.push(new Vec2(end.x, end.y));
					}
				}
			}
		};
		for (const child of this.m_rootElement?.children ?? []) {
			collect(child);
		}

		if (pts.length >= 3) {
			// Sort into a rough closed loop by nearest-next point.
			const order: Vec2[] = [pts[0]!];
			const remaining = pts.slice(1);
			while (remaining.length > 0 && order.length < pts.length) {
				const last = order[order.length - 1]!;
				let bestI = 0;
				let bestD = Infinity;
				for (let i = 0; i < remaining.length; i++) {
					const d = last.sub(remaining[i]!).squaredMagnitude;
					if (d < bestD) {
						bestD = d;
						bestI = i;
					}
				}
				order.push(remaining[bestI]!);
				remaining.splice(bestI, 1);
			}
			this.m_boardOutline.AddOutline(new SHAPE_LINE_CHAIN(order, true));
		}
	}

	private buildNetInfo(): void {
		const list: { GetNetCode(): number; GetNetname(): string }[] = [];
		for (const child of this.m_rootElement?.children ?? []) {
			if (child?.name === 'net') {
				const id = child.id ?? 0;
				const name = child.netName ?? '';
				list.push({ GetNetCode: () => id, GetNetname: () => name });
			}
		}
		this.m_netInfo.Build(list);
	}
}

/** Convenience: build a BOARD from the session's board root + scene. */
export function createBoard(aRootElement: any, aScene: LayeredBoardScene): BOARD {
	return new BOARD(aRootElement, aScene);
}
