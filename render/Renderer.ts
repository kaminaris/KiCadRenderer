import { Vec2 } from '../math/Vec2';
import { Matrix3 } from '../math/Matrix3';

export interface RenderStyle {
	strokeColor?: string;
	strokeWidth?: number;
	fillColor?: string;
}

/** An image payload embedded directly in a KiCad schematic's `(data ...)`
 * field. `data` is the decoded binary string supplied by kicad-io. */
export interface EmbeddedImage {
	data: string;
	mimeType: string;
}

/**
 * Backend-agnostic drawing primitives. Keep this dumb — it should have no
 * notion of "footprint" or "symbol", only shapes. That split (dumb renderer +
 * per-KiCad-element-type painters upstream) is the thing that made kicanvas's
 * architecture tractable, and is deliberately mirrored here. It's also what
 * made swapping Canvas2dRenderer for a WebGLRenderer possible without
 * touching BoardPainter's item-building logic at all — every PaintedItem's
 * draw() closure only ever calls these methods with WORLD-space coordinates.
 */
export interface Renderer {
	line(points: Vec2[], style: RenderStyle): void;
	polygon(points: Vec2[], style: RenderStyle): void;
	circle(center: Vec2, radius: number, style: RenderStyle): void;
	arc(center: Vec2, radius: number, startAngleRad: number, endAngleRad: number, style: RenderStyle): void;
	rect(topLeft: Vec2, width: number, height: number, style: RenderStyle): void;
	image(image: EmbeddedImage, topLeft: Vec2, width: number, height: number): void;
	/**
	 * Multiple point rings filled as ONE path with the even-odd rule — needed
	 * for glyph outlines (KiCad's text render_cache), where a letter like "G"
	 * or "0" is an outer ring plus one or more inner "hole" rings that must
	 * punch through rather than layer opaquely on top of the outer fill.
	 */
	multiPolygon(rings: Vec2[][], style: RenderStyle): void;

	/**
	 * Optional draw-call batching: between beginBatch()/endBatch(), primitive
	 * calls accumulate geometry instead of drawing immediately. What "commit"
	 * means is backend-specific — Canvas2dRenderer commits per-call to
	 * fill()/stroke() at endBatch(); WebGLRenderer just keeps accumulating
	 * into one GPU buffer across the whole frame (see flush()). Optional
	 * because not every Renderer implementation needs it — callers should
	 * feature-detect before using it.
	 */
	beginBatch?(): void;
	endBatch?(): void;

	/**
	 * Sets the opacity applied to primitives drawn after this call (until
	 * changed again) — replaces the old pattern of callers reaching into a
	 * CanvasRenderingContext2D directly to set globalAlpha, which had no
	 * WebGL equivalent.
	 */
	setOpacity?(opacity: number): void;

	/** Called once an asynchronously decoded embedded image is ready. */
	setImageLoadHandler?(handler: () => void): void;

	/** World-to-clip-space (or world-to-screen, for Canvas2D) transform for
	 * primitives drawn after this call. */
	setViewMatrix?(matrix: Matrix3): void;

	/** Clears the full canvas to the given color — start of frame. */
	clear?(color: string): void;

	/** Commits everything accumulated since the last flush() in as few
	 * actual GPU/canvas draw calls as the backend can manage — end of frame. */
	flush?(): void;

	/**
	 * Renderers that can retain GPU geometry across frames (currently just
	 * WebGLRenderer) expose this pair so a caller can rebuild the scene only
	 * when it actually changed (layer visibility/opacity, selection, a new
	 * board) instead of re-tessellating on every pan/zoom frame. Renderers
	 * that don't need this (Canvas2dRenderer, which is cheap enough to
	 * redraw immediately every frame) simply don't implement it — callers
	 * must feature-detect via `renderer.beginStaticBuild` before using it,
	 * and fall back to calling the painter every frame when absent.
	 */
	beginStaticBuild?(): void;
	endStaticBuild?(): void;

	/** Starts accumulating this frame's per-frame-only content (e.g. the
	 * camera-dependent grid) — only meaningful alongside beginStaticBuild. */
	beginDynamicFrame?(): void;
}
