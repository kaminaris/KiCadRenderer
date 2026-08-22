/*
 * Bridges the parsed board AST (@kicad-io KicadElement* objects) to the
 * connectivity engine's BOARD_ITEM / CN_ITEM_PARENT interface.
 *
 * Unlike BoardAdapter.ts (which wraps the flattened paint scene), this
 * facade is built straight from the board AST, so the connectivity code sees
 * the same item structure KiCad does:
 *   - pads grouped under their footprint (IsFreePad / origin-pad ranking /
 *     jumper pads work)
 *   - track arcs as PCB_ARC_T with their real start/end anchors
 *   - vias with their actual layer span from (layers ...)
 *   - a populated net code -> netname map
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later, same as the rest of this folder.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import {
	CN_ITEM_PARENT,
	CN_SHAPE,
	KICAD_T,
	LSET,
	PCB_LAYER_ID,
	PAD_ATTRIB,
} from './ConnectivityItems';
import { layerIndexOf, layerMaskOf } from './BoardAdapter';
import { SHAPE } from '../geometry/Shape';
import { SHAPE_RECT } from '../geometry/ShapeRect';
import { SHAPE_CIRCLE } from '../geometry/ShapeCircle';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { SHAPE_LINE_CHAIN } from '../geometry/ShapeLineChain';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { Angle } from '../math/Angle';
import { pointInPolygon } from '../geometry/polygon';
import { TransformShapeWithClearanceToPolygon } from '../geometry/ConvertToPolygon';
import { PAD_CLEARANCES } from './PadClearances';
import type { LayeredBoardScene } from '../paint/BoardPainter';

/** Element kinds the facade understands. */
type AstKind = 'footprint' | 'pad' | 'track' | 'arc' | 'via' | 'zone';

function elementKind(el: any): AstKind | null {
	switch (el?.name) {
		case 'footprint':
			return 'footprint';
		case 'pad':
			return 'pad';
		case 'segment':
			return 'track';
		case 'via':
			return 'via';
		case 'zone':
			return 'zone';
		case 'arc':
			// Both drawing arcs (KicadElementArc) and track arcs
			// (KicadElementTrackArc) are named 'arc'; track arcs carry a net.
			return typeof el.getNetId === 'function' ? 'arc' : null;
		default:
			return null;
	}
}

/** Effective copper layers of an element (expanding wildcards). */
function copperLayersOf(el: any, scene: LayeredBoardScene): string[] {
	const all = scene.copperLayerStack;

	// Prefer the plural `(layers ...)` accessor (vias, some pads). If the
	// element only exposes the singular `(layer "X")` form — segments, arcs,
	// track arcs, gr/fp shapes — fall back to getLayer(). Missing either
	// means the item has no resolvable copper layer (only non-copper items
	// should hit this).
	if (typeof el.getLayers === 'function') {
		const layers: string[] = el.getLayers(all);
		return layers.filter(l => l.endsWith('.Cu'));
	}

	if (typeof el.getLayer === 'function') {
		const single = el.getLayer();
		if (typeof single === 'string' && single.endsWith('.Cu')) {
			return [single];
		}
	}

	return [];
}

/**
 * Wraps a single @kicad-io board element, presenting the BOARD_ITEM /
 * CN_ITEM_PARENT surface the connectivity port consumes. `aFootprint` is set
 * for pads (their owning footprint adapter).
 */
export class AstAdapter implements CN_ITEM_PARENT {
	private m_el: any;
	private m_kind: AstKind;
	private m_scene: LayeredBoardScene;
	private m_footprint: AstAdapter | null = null;
	// Cached pad adapters (footprints only). Created once so the SAME pad
	// AstAdapter instances are returned on every Pads() call — this keeps
	// reference identity between the connectivity item map and the moving
	// items passed to GetRatsnestForItems / ComputeLocalRatsnest, mirroring
	// KiCad's stable BOARD_ITEM pointers.
	private m_pads: AstAdapter[] | null = null;

	constructor(el: any, kind: AstKind, scene: LayeredBoardScene, footprint: AstAdapter | null = null) {
		this.m_el = el;
		this.m_kind = kind;
		this.m_scene = scene;
		this.m_footprint = footprint;
	}

	Type(): number {
		switch (this.m_kind) {
			case 'footprint':
				return KICAD_T.PCB_FOOTPRINT_T;
			case 'pad':
				return KICAD_T.PCB_PAD_T;
			case 'track':
				return KICAD_T.PCB_TRACE_T;
			case 'arc':
				return KICAD_T.PCB_ARC_T;
			case 'via':
				return KICAD_T.PCB_VIA_T;
			case 'zone':
				return KICAD_T.PCB_ZONE_T;
		}
	}

	GetNetCode(): number {
		return this.m_el.getNetId?.() ?? -1;
	}

	GetNetname(): string {
		return this.m_el.getNetName?.() ?? '';
	}

	/** A pad's local clearance override (0 = none). Mirrors PAD::GetLocalClearance. */
	GetLocalClearance(): number {
		// The AST element may carry a custom LocalClearance; fall back to 0.
		const v = this.m_el?.getLocalClearance?.();
		return typeof v === 'number' ? v : 0;
	}

	/** The net class name this item's net belongs to (best-effort). */
	GetNetClassName(): string {
		return this.m_el?.getNetClass?.() ?? '';
	}

	/** The item's effective clearance (against a board default). */
	GetClearance(aBoardDefault = 0.2): number {
		return this.GetLocalClearance() || aBoardDefault;
	}

	/**
	 * The solder-mask opening polygon for a pad — the pad's effective shape
	 * expanded by the solder-mask margin. Mirrors PAD::GetSolderMaskPolygon.
	 * Returns null for non-pads.
	 */
	GetSolderMaskPolygon(aMargin = 0, aError = 0.005): SHAPE_POLY_SET | null {
		if (this.m_kind !== 'pad') {
			return null;
		}
		const poly = new SHAPE_POLY_SET();
		const shape = this.toShape();
		const clearances = new PAD_CLEARANCES();
		const margin = aMargin !== 0 ? aMargin : clearances.GetSolderMaskMargin();
		TransformShapeWithClearanceToPolygon(shape, poly, margin, aError);
		return poly;
	}

	/**
	 * The solder-paste (stencil) opening polygon for a pad, expanded by the
	 * solder-paste margin. Mirrors PAD::GetSolderPastePolygon. Returns null for
	 * non-pads.
	 */
	GetSolderPastePolygon(aMarginOverride = null, aError = 0.005): SHAPE_POLY_SET | null {
		if (this.m_kind !== 'pad') {
			return null;
		}
		const poly = new SHAPE_POLY_SET();
		const shape = this.toShape();
		const clearances = new PAD_CLEARANCES();
		const margin = aMarginOverride ?? clearances.GetSolderPasteMargin();
		TransformShapeWithClearanceToPolygon(shape, poly, margin, aError);
		return poly;
	}

	GetBoundingBox(): BBox {
		return this.toShape().BBox();
	}

	HitTest(aPoint: Vec2, aAccuracy?: number): boolean {
		const shape = this.toShape();
		return shape.Contains(aPoint, aAccuracy ?? 0.15);
	}

	IsOnCopperLayer(): boolean {
		if (this.m_kind === 'zone') {
			return this.copperLayers().length > 0;
		}
		return this.copperLayers().length > 0;
	}

	IsConnected(): boolean {
		return this.GetNetCode() > 0;
	}

	GetLayerSet(): LSET {
		if (this.m_kind === 'via') {
			return new LSET().AllCuMask();
		}

		let mask = 0n;
		for (const layer of this.copperLayers()) {
			mask |= layerMaskOf(layer);
		}
		return new LSET(mask);
	}

	GetEffectiveShape(_layer?: number, _flashing?: number): CN_SHAPE {
		// Return the canonical SHAPE_* geometry so the connectivity visitor's
		// collision is exact (routed through SHAPE_COLLISION). SHAPE satisfies
		// the CN_SHAPE interface structurally (BBox + Collide).
		return this.toShape() as unknown as CN_SHAPE;
	}

	GetLayer(): number {
		const layers = this.copperLayers();
		return layers.length > 0 ? layerIndexOf(layers[0]!) : 1;
	}

	GetWidth(): number {
		return this.m_el.getWidth?.() ?? 0;
	}

	GetStart(): Vec2 {
		if (typeof this.m_el.getStartMidEnd === 'function') {
			const { start } = this.m_el.getStartMidEnd();
			return new Vec2(start.x, start.y);
		}
		if (typeof this.m_el.getStartEnd === 'function') {
			const { start } = this.m_el.getStartEnd();
			return new Vec2(start.x, start.y);
		}
		return this.GetPosition();
	}

	GetEnd(): Vec2 {
		if (typeof this.m_el.getStartMidEnd === 'function') {
			const { end } = this.m_el.getStartMidEnd();
			return new Vec2(end.x, end.y);
		}
		if (typeof this.m_el.getStartEnd === 'function') {
			const { end } = this.m_el.getStartEnd();
			return new Vec2(end.x, end.y);
		}
		return this.GetPosition();
	}

	GetPosition(): Vec2 {
		const origin = this.m_el.getOrigin?.() ?? { x: 0, y: 0 };
		return new Vec2(origin.x, origin.y);
	}

	GetIsFree(): boolean {
		return this.GetNetCode() <= 0;
	}

	GetAttribute(): number {
		if (this.m_kind !== 'pad') {
			return PAD_ATTRIB.SMD;
		}

		switch (this.m_el.padType) {
			case 'thru_hole':
				return PAD_ATTRIB.PTH;
			case 'np_thru_hole':
				return PAD_ATTRIB.NPTH;
			case 'smd':
			default:
				return PAD_ATTRIB.SMD;
		}
	}

	GetConnectionPoints(): Vec2[] {
		if (this.m_kind === 'pad' || this.m_kind === 'via') {
			return [this.GetPosition()];
		}
		return [this.GetStart(), this.GetEnd()];
	}

	ForEachUniqueLayer(fn: (layer: number) => void): void {
		fn(this.GetLayer());
	}

	Padstack(): { ForEachUniqueLayer: (fn: (layer: number) => void) => void } {
		return { ForEachUniqueLayer: (fn: (layer: number) => void) => fn(this.GetLayer()) };
	}

	ShapePos(_layer: number): Vec2 {
		return this.GetPosition();
	}

	TopLayer(): number {
		const layers = this.copperLayers();
		return layers.length > 0 ? layerIndexOf(layers[0]!) : PCB_LAYER_ID.F_Cu;
	}

	BottomLayer(): number {
		const layers = this.copperLayers();
		return layers.length > 1
			? layerIndexOf(layers[layers.length - 1]!)
			: PCB_LAYER_ID.B_Cu;
	}

	IsTeardropArea(): boolean {
		return false;
	}

	GetFilledPolysList(layer: number): PN_POLY_LIST | null {
		if (this.m_kind !== 'zone') {
			return null;
		}

		const zoneLayer = this.copperLayerName(layer);
		const zone = this.m_scene.zoneFills.find(
			z => z.layer === zoneLayer && z.netId === this.GetNetCode()
		);

		if (!zone) {
			return null;
		}

		const outlines = zone.points as { x: number; y: number }[];

		// Build the canonical SHAPE_POLY_SET from the zone outline and
		// triangulate it. This gives CN_ZONE_LAYER's R-tree real triangles so
		// zone↔item collisions (ContainsPoint/Collide) actually fire.
		const polySet = new SHAPE_POLY_SET();

		if (outlines && outlines.length > 0) {
			polySet.AddOutline(
				new SHAPE_LINE_CHAIN(
					outlines.map(p => new Vec2(p.x, p.y)),
					true
				)
			);
		}

		// Triangulate per outline index. SHAPE_POLY_SET.Triangulate returns
		// triangles tagged with `owner` = outline index.
		const trianglesByOutline: Map<number, Array<{ A: Vec2; B: Vec2; C: Vec2; BBox(): BBox }>> = new Map();
		const tris = polySet.Triangulate();

		for (const t of tris) {
			const key = t.owner;
			if (!trianglesByOutline.has(key)) {
				trianglesByOutline.set(key, []);
			}
			trianglesByOutline.get(key)!.push({
				A: t.A,
				B: t.B,
				C: t.C,
				BBox: () => BBox.fromPoints([t.A, t.B, t.C]),
			});
		}

		const outlineCount = outlines ? 1 : 0;

		return {
			IsEmpty: () => !outlines || outlines.length === 0,
			OutlineCount: () => outlineCount,
			Outline: (_index: number) => ({ CPoints: () => outlines.map(p => new Vec2(p.x, p.y)) }),
			COutline: (_index: number) => ({ CPoints: () => outlines.map(p => new Vec2(p.x, p.y)) }),
			TriangulatedPolyCount: () => trianglesByOutline.size,
			TriangulatedPolygon: (ii: number) => ({
				GetSourceOutlineIndex: () => ii,
				Triangles: () => trianglesByOutline.get(ii) ?? [],
			}),
		};
	}

	HitTestFilledArea(layer: number, point: Vec2, accuracy: number): boolean {
		const zoneLayer = this.copperLayerName(layer);
		const zone = this.m_scene.zoneFills.find(
			z => z.layer === zoneLayer && z.netId === this.GetNetCode()
		);
		if (!zone) {
			return false;
		}
		return pointInPolygon(point, zone.points, accuracy);
	}

	/** The owning footprint adapter (pads only). */
	GetParentFootprint(): AstAdapter | null {
		return this.m_kind === 'pad' ? this.m_footprint : null;
	}

	IsFreePad(): boolean {
		// Mirrors PAD::IsFreePad(): a pad whose parent is not a footprint.
		return this.m_kind !== 'pad' || this.m_footprint === null;
	}

	GetNumber(): string {
		return this.m_el.padNumber ?? '';
	}

	GetDuplicatePadNumbersAreJumpers(): boolean {
		return this.m_footprint?.m_el?.duplicate_pin_numbers_are_jumpers ?? false;
	}

	JumperPadGroups(): string[][] {
		return this.m_footprint?.m_el?.jumper_pad_groups ?? [];
	}

	GetBoard(): null {
		return null;
	}

	/** The wrapped AST element (for Update/Remove identity). */
	Element(): any {
		return this.m_el;
	}

	Kind(): AstKind {
		return this.m_kind;
	}

	/** Footprints only: the pads owned by this footprint. */
	Pads(): AstAdapter[] {
		if (this.m_kind !== 'footprint') {
			return [];
		}
		if (this.m_pads) {
			return this.m_pads;
		}

		const pads: AstAdapter[] = [];

		for (const padEl of this.m_el.children ?? []) {
			if (padEl?.name === 'pad') {
				pads.push(new AstAdapter(padEl, 'pad', this.m_scene, this));
			}
		}

		this.m_pads = pads;
		return pads;
	}

	private copperLayers(): string[] {
		return copperLayersOf(this.m_el, this.m_scene);
	}

	private copperLayerName(layer: number): string {
		if (layer === PCB_LAYER_ID.F_Cu) {
			return 'F.Cu';
		}
		if (layer === PCB_LAYER_ID.B_Cu) {
			return 'B.Cu';
		}
		const stack = this.m_scene.copperLayerStack;
		if (stack && stack[layer]) {
			return stack[layer]!;
		}
		if (layer >= 1 && layer <= 30) {
			return `In${ layer }.Cu`;
		}
		return stack?.[0] ?? 'F.Cu';
	}

	/**
	 * Returns the canonical SHAPE_* geometry of this item — the geometry-parity
	 * replacement for the ad-hoc PaintedShape/PaintedShapeAdapter. Pads are
	 * SHAPE_RECT, vias SHAPE_CIRCLE, tracks/arcs SHAPE_SEGMENT, zones
	 * SHAPE_POLY_SET (from the scene's filled-zone outline).
	 */
	toShape(): SHAPE {
		const el = this.m_el;

		switch (this.m_kind) {
			case 'pad': {
				const origin = el.getOrigin?.() ?? { x: 0, y: 0, rotation: 0 };
				const size = el.getSize?.() ?? { width: 0, height: 0 };
				const shape: string = el.shape ?? 'rect';
				const pos = new Vec2(origin.x, origin.y);
				const rotation = origin.rotation ?? 0;

				// Custom pads: use the primitive gr_poly rings as the effective shape,
				// unioned with the anchor rect. Mirrors PAD::GetEffectiveShape for
				// PAD_SHAPE::CUSTOM (pcbnew/pad.cpp).
				if (shape === 'custom') {
					const rings = typeof el.getCustomPolygonPoints === 'function'
						? el.getCustomPolygonPoints()
						: [];

					if (rings.length > 0) {
						const polySet = new SHAPE_POLY_SET();
						const angle = new Angle(rotation);

						for (const ring of rings) {
							const pts = ring.map((p: { x: number; y: number }) => {
								const local = new Vec2(p.x, p.y);
								return angle.rotatePoint(local, new Vec2(0, 0)).add(pos);
							});
							polySet.AddOutline(new SHAPE_LINE_CHAIN(pts, true));
						}

						// KiCad custom pads are the union of the primitive polygons
						// with the anchor (size) rectangle.
						const anchorHalfW = size.width / 2;
						const anchorHalfH = size.height / 2;
						const anchorPts = [
							new Vec2(-anchorHalfW, -anchorHalfH),
							new Vec2(anchorHalfW, -anchorHalfH),
							new Vec2(anchorHalfW, anchorHalfH),
							new Vec2(-anchorHalfW, anchorHalfH),
						].map(p => angle.rotatePoint(p, new Vec2(0, 0)).add(pos));
						polySet.AddOutline(new SHAPE_LINE_CHAIN(anchorPts, true));

						return polySet;
					}
				}

				// Map the KiCad pad shape to the canonical SHAPE geometry,
				// mirroring PAD::GetEffectiveShape (pcbnew/pad.cpp): an oval
				// pad is a wide segment between the two rounded caps; a circle
				// is a disc; rect/roundrect default to an axis-aligned box.
				if (shape === 'circle') {
					return new SHAPE_CIRCLE(pos, size.width / 2);
				}
				if (shape === 'oval') {
					const d = size.width; // oval diameter = min dimension
					const len = Math.max(size.width, size.height) - d;
					const half = len / 2;
					// Horizontal vs vertical oval.
					if (size.width > size.height) {
						return new SHAPE_SEGMENT(
							new Vec2(origin.x - half, origin.y),
							new Vec2(origin.x + half, origin.y),
							d
						);
					}
					return new SHAPE_SEGMENT(
						new Vec2(origin.x, origin.y - half),
						new Vec2(origin.x, origin.y + half),
						d
					);
				}
				// rect / roundrect / trapezoid (bounded approximation)
				return new SHAPE_RECT(
					new Vec2(origin.x - size.width / 2, origin.y - size.height / 2),
					new Vec2(size.width, size.height)
				);
			}
			case 'via': {
				const origin = el.getOrigin?.() ?? { x: 0, y: 0 };
				const size = el.getSize?.() ?? { width: 0, height: 0 };
				return new SHAPE_CIRCLE(new Vec2(origin.x, origin.y), size.width / 2);
			}
			case 'track':
			case 'arc': {
				const width = el.getWidth?.() ?? 0.25;
				return new SHAPE_SEGMENT(this.GetStart(), this.GetEnd(), width);
			}
			case 'zone':
			default: {
				const zone = this.m_scene.zoneFills.find(z => z.netId === this.GetNetCode());
				if (zone && zone.points && zone.points.length > 0) {
					const ps = new SHAPE_POLY_SET();
					ps.AddOutline(
						new SHAPE_LINE_CHAIN(
							zone.points.map(p => new Vec2(p.x, p.y)),
							true
						)
					);
					return ps;
				}
				return new SHAPE_RECT(new Vec2(0, 0), new Vec2(0, 0));
			}
		}
	}
}

/** The board facade shape CN_CONNECTIVITY_ALGO::Build() consumes. */
export interface KicadBoardFacade {
	Zones(): AstAdapter[];
	Tracks(): AstAdapter[];
	Footprints(): AstAdapter[];
	Drawings(): never[];
	GetEnabledLayers(): LSET;
	GetNetInfo(): { GetNetCode(): number; GetNetname(): string }[];
}

/**
 * Builds the board facade from the parsed board AST. `rootElement` is the
 * `(kicad_pcb ...)` root (the session's boardRoot.rootElement).
 */
export function buildBoardFacadeFromAst(rootElement: any, scene: LayeredBoardScene): KicadBoardFacade {
	const footprints: AstAdapter[] = [];
	const tracks: AstAdapter[] = [];
	const vias: AstAdapter[] = [];
	const zones: AstAdapter[] = [];
	const netInfo: { GetNetCode(): number; GetNetname(): string }[] = [];

	for (const child of rootElement.children ?? []) {
		switch (child?.name) {
			case 'net': {
				const id = child.id ?? 0;
				const name = child.netName ?? '';
				netInfo.push({
					GetNetCode: () => id,
					GetNetname: () => name,
				});
				break;
			}
			case 'footprint': {
				footprints.push(new AstAdapter(child, 'footprint', scene));
				break;
			}
			case 'segment': {
				tracks.push(new AstAdapter(child, 'track', scene));
				break;
			}
			case 'arc': {
				// Track arcs carry a net; drawing arcs don't.
				if (typeof child.getNetId === 'function') {
					tracks.push(new AstAdapter(child, 'arc', scene));
				}
				break;
			}
			case 'via': {
				vias.push(new AstAdapter(child, 'via', scene));
				break;
			}
			case 'zone': {
				zones.push(new AstAdapter(child, 'zone', scene));
				break;
			}
		}
	}

	// Pads are reachable via footprint.Pads() (the algo's Build() adds pads
	// from footprint.Pads()); tracks/arcs/vias are top-level board items.
	const allTracks = [...tracks, ...vias];

	return {
		Zones: () => zones,
		Tracks: () => allTracks,
		Footprints: () => footprints,
		Drawings: () => [],
		GetEnabledLayers: () => new LSET().AllCuMask(),
		GetNetInfo: () => netInfo,
	};
}

export interface PN_POLY_LIST {
	IsEmpty(): boolean;
	OutlineCount(): number;
	Outline(index: number): PN_POLY_LINE;
	COutline(index: number): PN_POLY_LINE;
	TriangulatedPolyCount(): number;
	TriangulatedPolygon(index: number): TriangulatedPolygon;
}

export interface PN_POLY_LINE {
	CPoints(): Vec2[];
}

export interface TriangulatedPolygon {
	GetSourceOutlineIndex(): number;
	Triangles(): CN_TRI[];
}

export interface CN_TRI {
	A: Vec2;
	B: Vec2;
	C: Vec2;
	BBox(): BBox;
}
