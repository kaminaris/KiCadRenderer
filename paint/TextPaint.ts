import { Angle } from '../math/Angle';
import { Vec2 }  from '../math/Vec2';
import { StrokeFont } from '../text/StrokeFont';
import { Renderer }   from '../render/Renderer';
import { unescapeKicadString } from './KicadStringEscapes';

export interface WeightedStroke {
	points: Vec2[];
	width: number;
}

export interface DotMark {
	center: Vec2;
	radius: number;
}

export interface StrokeTextGeometry {
	strokes: WeightedStroke[];
	dots: DotMark[];
}

// Newstroke's '.' (and similar punctuation) glyph isn't a simple short
// segment — it's a tiny closed diamond roughly a tenth of the em-square
// across, positioned with normal side-bearings (so its OWN cursor-advance
// width is unaffected — the earlier report of "the next zero renders on
// top of the dot" wasn't a layout bug, cursor advance was always correct;
// it was this file's own first fix, which widened the diamond's STROKE
// width 2x — the stroke of a shape that's already only ~0.1*sizeMm across
// ends up thicker than the shape itself and visibly bleeds outside its own
// cell into the neighboring glyph). Rendering these as a small FILLED
// circle at the stroke's centroid instead — not a thickened outline —
// gives precise control over how much space the mark actually occupies.
const smallStrokeBboxThreshold = 0.18;
// Radius as a fraction of sizeMm. 0.05 (diameter ~0.1*sizeMm) matched the
// original Newstroke glyph's own footprint but rendered as a barely-visible
// speck — smaller than the ~0.15*sizeMm-ish stroke width the surrounding
// characters are drawn with, so a period read as almost nothing at normal
// zoom. Bumped so the dot's diameter is comparable to normal stroke
// thickness instead of smaller than it.
const dotRadiusFactor = 0.09;

/**
 * Decodes a string into Newstroke line-segment geometry ONCE. This is the
 * expensive half of stroke-text rendering (font lookup + per-glyph
 * transform) — callers that build a PaintedItem should call this at BUILD
 * time and store the result in the item's draw closure, not call
 * paintStrokeText() every frame. Text is 100% static board data; redoing
 * this decode on every repaint (which is what the original implementation
 * did) was measured to account for the large majority of per-frame cost on
 * a text-heavy board — confirmed by disabling silkscreen/fab/user-text
 * layers and watching render time drop roughly 3-4x.
 *
 * `anchor` is the normalized (0-1) point within the laid-out text that
 * `position` should land on — {x:0,y:0} (the default) is KiCad's "top-left"
 * behavior, which is what get_text_as_glyphs() natively does (lays out
 * left-to-right starting exactly at `position`, no centering). But
 * @kicad-io's WithJustify mixin reports KiCad's REAL default as
 * middle/middle when a text element has no explicit `justify` — which is
 * the common case for dimension labels — so a caller that always passes
 * {x:0,y:0} silently mismatches KiCad's actual anchor and every such label
 * reads as anchored to its left edge instead of centered on its point.
 * Implemented as measure-then-shift: lay the text out once at the origin to
 * get its true (unrotated) width/height, then shift `position` by the
 * anchor fraction of that size ALONG THE TEXT'S OWN (rotated) axes before
 * the real layout call — shifting the already-rotated glyph geometry
 * afterwards would be equivalent but more error-prone to get right.
 */
interface TextRun {
	text: string;
	overbar: boolean;
}

/**
 * Parses KiCad's `~{...}` inline overbar markup (e.g. `~{RESET}`, used for
 * active-low signal names) into plain-text runs each flagged whether they
 * should render with a bar drawn above them. This is a real KiCad text
 * convention read straight from schematic/symbol text, not custom syntax —
 * StrokeFont.get_text_as_glyphs() already supports drawing an overbar over
 * a whole call's output (`style.overbar`), it just needed the markup split
 * into runs first since a single call only draws one bar over everything.
 */
function parseOverbarRuns(text: string): TextRun[] {
	const runs: TextRun[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] === '~' && text[i + 1] === '{') {
			const end = text.indexOf('}', i + 2);
			if (end !== -1) {
				runs.push({ text: text.slice(i + 2, end), overbar: true });
				i = end + 1;
				continue;
			}
		}
		let j = i;
		while (j < text.length && !(text[j] === '~' && text[j + 1] === '{')) {
			j++;
		}
		runs.push({ text: text.slice(i, j), overbar: false });
		i = j;
	}
	return runs;
}

/**
 * Lays out multiple runs back-to-back on the same line/baseline, chaining
 * each run's end cursor into the next run's start position. This relies on
 * StrokeGlyph.transform() rotating each glyph about a SHARED `origin` at the
 * very end of its own transform — as long as every run in the chain passes
 * the same `angle`/`origin`, the intermediate per-run cursor arithmetic
 * happens entirely in pre-rotation space and the whole chain comes out
 * exactly as if it had been laid out in one call.
 */
function layoutRuns(
	font: StrokeFont, runs: TextRun[], size: Vec2, position: Vec2, angle: Angle, mirror: boolean, origin: Vec2
): { glyphs: import('../text/StrokeGlyph').StrokeGlyph[]; bboxEnd: Vec2 } {
	const glyphs: import('../text/StrokeGlyph').StrokeGlyph[] = [];
	let cursor = position;
	let bboxEnd = position;
	for (const run of runs) {
		const laid = font.getTextAsGlyphs(run.text, size, cursor, angle, mirror, origin, { overbar: run.overbar });
		glyphs.push(...(laid.glyphs as import('../text/StrokeGlyph').StrokeGlyph[]));
		cursor = laid.cursor;
		bboxEnd = laid.bbox.end;
	}
	return { glyphs, bboxEnd };
}

/**
 * Measures a string's rendered stroke bbox at a given size, without laying
 * out or drawing anything — used by label painters that need to know a
 * label's own text width up front to size an outline flag/arrow shape
 * around it (ports KiCad's EDAText::GetTextBox(), the same real-glyph-bbox
 * measurement computeStrokeTextGeometry() already does internally for
 * anchor calculation, pulled out here as its own reusable step).
 */
export function measureStrokeTextSize(text: string, sizeMm: number): { width: number; height: number } {
	if (!text) {
		return { width: 0, height: 0 };
	}
	const font = StrokeFont.default();
	const size = new Vec2(sizeMm, sizeMm);
	// Must match computeStrokeTextGeometry's own unescaping — a global/hier
	// label name containing an escaped char (e.g. "I2C2 SDA{slash}USART3
	// RX") would otherwise measure the width of the raw ESCAPED string
	// (7 chars for "{slash}" vs. the 1 displayed char "/"), sizing the
	// flag/arrow shape around text far wider than what's actually drawn.
	const runs = parseOverbarRuns(unescapeKicadString(text));
	const measured = layoutRuns(font, runs, size, new Vec2(0, 0), new Angle(0), false, new Vec2(0, 0));
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const glyph of measured.glyphs) {
		for (const points of glyph.strokes) {
			for (const p of points) {
				minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
				maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
			}
		}
	}
	const width = maxX > minX ? maxX - minX : measured.bboxEnd.x;
	const height = maxY > minY ? maxY - minY : measured.bboxEnd.y;
	return { width: width || sizeMm, height: height || sizeMm };
}

// KiCad's Font::interline_pitch_ratio — vertical spacing between stacked
// lines of a multiline text item, as a multiple of the font's own size.
const interlinePitchRatio = 1.62;

interface MeasuredLine {
	runs: TextRun[];
	minX: number; maxX: number; minY: number; maxY: number;
	width: number;
}

/** Multiline text (KiCad text items always support embedded `\n` line
 * breaks — this is unconditional in EDA_TEXT, not an opt-in flag) is laid
 * out by stacking each line `interline` apart, then anchoring the WHOLE
 * BLOCK vertically (top/center/bottom) while each line still gets its own
 * horizontal anchor against its own width — ports KiCad's
 * Font::get_line_positions(). Single-line text is just this loop running
 * once, so it degenerates to the exact same math the old single-line-only
 * implementation used (verified: with one line at offset 0, this produces
 * bit-identical results). */
export function computeStrokeTextGeometry(
	text: string,
	position: Vec2,
	sizeMm: number,
	angleDeg: number,
	mirror: boolean,
	strokeWidthMm = 0.15,
	anchor: { x: number; y: number } = { x: 0, y: 0 }
): StrokeTextGeometry {
	if (!text) {
		return { strokes: [], dots: [] };
	}
	const font = StrokeFont.default();
	const size = new Vec2(sizeMm, sizeMm);
	const interline = sizeMm * interlinePitchRatio;
	// Every text value this renderer draws flows through here — the single
	// choke point to unescape KiCad's `{name}` character escapes (see
	// KicadStringEscapes.ts) regardless of which element the text came from
	// (label, symbol text, property value, drawing-sheet tbtext, ...).
	const rawLines = unescapeKicadString(text).split('\n');

	// Measure each line's own runs at its own (unshifted, unrotated) stacked
	// offset — get_text_as_glyphs's own bbox is cursor-based and doesn't
	// capture descenders (glyph points below the layout baseline), so the
	// true bbox is computed from strokes, same as the old single-line pass.
	const lines: MeasuredLine[] = rawLines.map((line, i) => {
		const runs = parseOverbarRuns(line);
		const measured = layoutRuns(font, runs, size, new Vec2(0, i * interline), new Angle(0), mirror, new Vec2(0, i * interline));
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const glyph of measured.glyphs) {
			for (const points of glyph.strokes) {
				for (const p of points) {
					minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
					maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
				}
			}
		}
		const width = (maxX > minX ? maxX - minX : measured.bboxEnd.x) || sizeMm;
		return { runs, minX, maxX, minY, maxY, width };
	});

	// Block-level vertical bbox (union across all lines) — anchor.y is
	// applied against this, once, for every line (KiCad anchors the whole
	// multiline block vertically, not each line independently).
	let blockMinY = Infinity, blockMaxY = -Infinity;
	for (const l of lines) {
		if (l.minY < l.maxY) {
			blockMinY = Math.min(blockMinY, l.minY);
			blockMaxY = Math.max(blockMaxY, l.maxY);
		}
	}
	const hasStrokes = blockMinY < blockMaxY;
	const blockHeight = (hasStrokes ? blockMaxY - blockMinY : 0) || sizeMm;
	// The Newstroke font_offset=-10 shifts all glyphs below the layout
	// baseline, so layout-bbox centering (anchor.y=0.5) puts visual content
	// ~1 font-height too high. Align within the VISUAL stroke bbox instead:
	// anchor.y=0 → strokeMinY (top), 0.5 → middle, 1 → bottom.
	const targetY = hasStrokes ? blockMinY + anchor.y * blockHeight : -anchor.y * blockHeight;
	const localShiftY = -targetY;

	// Must match StrokeGlyph.transform()'s own rotation exactly (via
	// Angle.rotate_point()) — x=y0*sin+x0*cos, y=y0*cos-x0*sin — not the
	// textbook rotation-matrix formula, which uses the opposite sign
	// convention and would shift centered text off-axis for anything
	// rotated away from 0/180 degrees.
	const angleRad = Angle.degToRad(angleDeg);
	const cos = Math.cos(angleRad), sin = Math.sin(angleRad);

	const allGlyphs: import('../text/StrokeGlyph').StrokeGlyph[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Horizontal anchor is per-line, against that line's own VISUAL
		// stroke bbox — same reasoning as the vertical shift above, mirrored
		// onto X: a glyph's decoded points don't necessarily start exactly
		// at local x=0 (confirmed via a real glyph, "A" at 1.3mm has a
		// +0.124mm left bearing), so assuming minX=0 and shifting by only
		// `-anchor.x*width` left a center-anchored single character (e.g.
		// the drawing-sheet's column ruler letters) visibly off-center by
		// that same bearing — small in mm, but a very noticeable "couple
		// pixels" at typical zoom. anchor.x=0 → strokeMinX (left), 0.5 →
		// middle, 1 → right, exactly like the Y case just above.
		const lineHasStrokes = line.minX < line.maxX;
		const targetX = lineHasStrokes ? line.minX + anchor.x * line.width : -anchor.x * line.width;
		const localShiftX = -targetX;
		const localY = i * interline + localShiftY;
		const layoutPosition = new Vec2(
			position.x + (localY * sin + localShiftX * cos),
			position.y + (localY * cos - localShiftX * sin)
		);
		const { glyphs } = layoutRuns(font, line.runs, size, layoutPosition, Angle.fromDegrees(angleDeg), mirror, layoutPosition);
		allGlyphs.push(...(glyphs as import('../text/StrokeGlyph').StrokeGlyph[]));
	}

	const smallStrokeThreshold = sizeMm * smallStrokeBboxThreshold;
	const dotRadius = sizeMm * dotRadiusFactor;
	const strokes: WeightedStroke[] = [];
	const dots: DotMark[] = [];
	for (const glyph of allGlyphs) {
		for (const points of glyph.strokes) {
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sumX = 0, sumY = 0;
			for (const p of points) {
				minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
				maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
				sumX += p.x; sumY += p.y;
			}
			const isSmall = (maxX - minX) < smallStrokeThreshold && (maxY - minY) < smallStrokeThreshold;
			if (isSmall) {
				dots.push({ center: new Vec2(sumX / points.length, sumY / points.length), radius: dotRadius });
			}
			else {
				strokes.push({ points, width: strokeWidthMm });
			}
		}
	}
	return { strokes, dots };
}

/** Cheap replay of geometry already computed by computeStrokeTextGeometry(). */
export function drawStrokeTextGeometry(renderer: Renderer, geometry: StrokeTextGeometry, color: string): void {
	for (const stroke of geometry.strokes) {
		renderer.line(stroke.points, { strokeColor: color, strokeWidth: stroke.width });
	}
	for (const dot of geometry.dots) {
		renderer.circle(dot.center, dot.radius, { fillColor: color });
	}
}

/**
 * Convenience one-shot (decode + draw immediately) for callers that don't
 * need caching — e.g. a future interactive editor drawing text that changes
 * every frame. Every PaintedItem builder in BoardPainter.ts should prefer
 * computeStrokeTextGeometry() + drawStrokeTextGeometry() instead.
 */
export function paintStrokeText(
	renderer: Renderer,
	text: string,
	position: Vec2,
	sizeMm: number,
	angleDeg: number,
	mirror: boolean,
	color: string,
	strokeWidthMm = 0.15
): void {
	const geometry = computeStrokeTextGeometry(text, position, sizeMm, angleDeg, mirror, strokeWidthMm);
	drawStrokeTextGeometry(renderer, geometry, color);
}
