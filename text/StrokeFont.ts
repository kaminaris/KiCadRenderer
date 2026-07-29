/*
	Adapted from kicanvas (https://github.com/theacodes/kicanvas), MIT License.
	Copyright (c) 2023 Alethea Katherine Flowers.
	Full text available at: https://opensource.org/licenses/MIT

	Simplified for the BOMManager2 renderer spike: drops kicanvas's
	Font base class (Renderer/Polyline-coupled draw() methods we don't need,
	since our own Canvas2dRenderer draws the glyph strokes directly) and its
	Markup/MarkupNode inline-markup layer (subscript/superscript/overbar
	syntax) — getTextAsGlyphs() here operates on plain single-line text.
	The actual hard part (Newstroke glyph decoding) is unchanged.
*/

import { Angle } from '../math/Angle';
import { BBox }  from '../math/BBox';
import { Vec2 }  from '../math/Vec2';
import { Glyph } from './Glyph';
import { StrokeGlyph } from './StrokeGlyph';
import * as newstroke from './NewstrokeGlyphs';

export interface TextStyle {
	italic?: boolean;
	subscript?: boolean;
	superscript?: boolean;
	overbar?: boolean;
	underline?: boolean;
}

/** Stroke font ("Hershey" font comprised of strokes) — adapted from KiCAD's STROKE_FONT. */
export class StrokeFont {
	static readonly overbarPositionFactor = 1.4;
	static readonly underlinePositionFactor = -0.16;
	static readonly fontScale = 1 / 21;
	static readonly fontOffset = -10;
	static readonly italicTilt = 1.0 / 8;
	static readonly interlinePitchRatio = 1.62;

	protected static instance?: StrokeFont;

	static default(): StrokeFont {
		if (!this.instance) {
			this.instance = new StrokeFont();
		}
		return this.instance;
	}

	// Use TS `protected` (not native `#field`) so subclassing stays easy and
	// consumers with `importHelpers` (e.g. Angular) don't need tslib for
	// sources living outside a package's node_modules tree.
	protected glyphs: Map<number, StrokeGlyph> = new Map();
	protected sharedGlyphs: StrokeGlyph[] = [];

	constructor() {
		this.load();
	}

	protected load() {
		for (const glyphData of newstroke.sharedGlyphs) {
			this.sharedGlyphs.push(decodeGlyph(glyphData));
		}

		// Only the first 256 glyphs are loaded up front; the rest are lazy
		// loaded on demand to save memory/CPU (matches kicanvas's approach).
		for (let i = 0; i < 256; i++) {
			this.loadGlyph(i);
		}
	}

	protected loadGlyph(idx: number) {
		const data: number | string | undefined = newstroke.glyphData[idx];
		if (typeof data === 'string') {
			this.glyphs.set(idx, decodeGlyph(data));
		}
		else if (typeof data === 'number') {
			const glyph = this.sharedGlyphs[data]!;
			this.glyphs.set(idx, glyph);
		}
		else {
			throw new Error(`Invalid glyph data for glyph ${ idx }: ${ data }`);
		}

		newstroke.glyphData[idx] = undefined;
	}

	getGlyph(c: string): StrokeGlyph {
		const glyphIndex = c.charCodeAt(0) - ' '.charCodeAt(0);

		if (glyphIndex < 0 || glyphIndex > newstroke.glyphData.length) {
			return this.getGlyph('?');
		}

		if (!this.glyphs.has(glyphIndex)) {
			this.loadGlyph(glyphIndex);
		}

		return this.glyphs.get(glyphIndex)!;
	}

	computeUnderlineVerticalPosition(glyphHeight: number): number {
		return glyphHeight * StrokeFont.underlinePositionFactor;
	}

	computeOverbarVerticalPosition(glyphHeight: number): number {
		return glyphHeight * StrokeFont.overbarPositionFactor;
	}

	getInterline(glyphHeight: number, lineSpacing = 1): number {
		return glyphHeight * lineSpacing * StrokeFont.interlinePitchRatio;
	}

	/**
	 * Converts a single line of plain text into stroke glyphs, positioned,
	 * rotated, and mirrored as requested.
	 */
	getTextAsGlyphs(
		text: string,
		size: Vec2,
		position: Vec2,
		angle: Angle,
		mirror: boolean,
		origin: Vec2,
		style: TextStyle = {}
	): { bbox: BBox; glyphs: Glyph[]; cursor: Vec2 } {
		// Magic numbers from STROKE_FONT::GetTextAsGlyphs
		const spaceWidth = 0.6;
		const interChar = 0.2;
		const tabWidth = 4 * 0.82;
		const superSubSizeMultiplier = 0.7;
		const superHeightOffset = 0.5;
		const subHeightOffset = 0.3;

		const glyphs: Glyph[] = [];

		const cursor = position.copy();
		let glyphSize = size.copy();

		const tilt = style.italic ? StrokeFont.italicTilt : 0;
		if (style.subscript || style.superscript) {
			glyphSize = glyphSize.multiply(superSubSizeMultiplier);

			if (style.subscript) {
				cursor.y += glyphSize.y * subHeightOffset;
			}
			else {
				cursor.y -= glyphSize.y * superHeightOffset;
			}
		}

		for (const c of text) {
			if (c === '\t') {
				const charTabWidth = Math.round(glyphSize.x * tabWidth);
				const currentIntrusion = (cursor.x - origin.x) % charTabWidth;
				cursor.x += charTabWidth - currentIntrusion;
			}
			else if (c === ' ') {
				cursor.x += glyphSize.x * spaceWidth;
			}
			else {
				const source = this.getGlyph(c);
				const extents = source.bbox.end.multiply(glyphSize);

				glyphs.push(
					source.transform(glyphSize, cursor, tilt, angle, mirror, origin)
				);

				if (tilt) {
					extents.x -= extents.y * tilt;
				}

				cursor.x += extents.x;
			}
		}

		let hasBar = false;
		const barOffset = new Vec2(0, 0);
		const barTrim = glyphSize.x * 0.1;

		if (style.overbar) {
			hasBar = true;
			barOffset.y = this.computeOverbarVerticalPosition(glyphSize.y);
		}
		else if (style.underline) {
			hasBar = true;
			barOffset.y = this.computeUnderlineVerticalPosition(glyphSize.y);
		}

		if (hasBar) {
			if (style.italic) {
				barOffset.x = barOffset.y * StrokeFont.italicTilt;
			}

			const barStart = new Vec2(
				position.x + barOffset.x + barTrim,
				cursor.y - barOffset.y
			);
			const barEnd = new Vec2(
				cursor.x + barOffset.x - barTrim,
				cursor.y - barOffset.y
			);

			const barGlyph = new StrokeGlyph(
				[[barStart, barEnd]],
				BBox.fromPoints([barStart, barEnd])
			);

			glyphs.push(
				barGlyph.transform(new Vec2(1, 1), new Vec2(0, 0), 0, angle, mirror, origin)
			);
		}

		const bbox = new BBox();
		bbox.start = position;
		bbox.end = new Vec2(
			cursor.x + barOffset.x - glyphSize.x * interChar,
			cursor.y + Math.max(glyphSize.y, barOffset.y * StrokeFont.overbarPositionFactor)
		);

		return { bbox, glyphs, cursor: new Vec2(cursor.x, position.y) };
	}
}

function decodeCoordVal(c: string): number {
	return c.charCodeAt(0) - 'R'.charCodeAt(0);
}

/**
 * Parses a Newstroke glyph.
 *
 * Notes (from KiCAD's STROKE_FONT::LoadNewStrokeFont):
 *  - Coordinate values are coded as ASCII characters relative to "R".
 *  - Coordinate values are -1 to +1.
 *  - font_offset is used to allow descenders that go below the baseline.
 */
function decodeGlyph(glyphData: string): StrokeGlyph {
	let startX = 0;
	let width = 0;
	let minY = 0;
	let maxY = 0;
	const strokes: Vec2[][] = [];
	let points: Vec2[] | null = null;

	for (let i = 0; i < glyphData.length; i += 2) {
		const c0 = glyphData[i]!;
		const c1 = glyphData[i + 1]!;

		if (i < 2) {
			// The first coord contains the horizontal bounding box.
			startX = decodeCoordVal(c0) * StrokeFont.fontScale;
			const endX = decodeCoordVal(c1) * StrokeFont.fontScale;
			width = endX - startX;
		}
		else if (c0 === ' ' && c1 === 'R') {
			// End of stroke.
			points = null;
		}
		else {
			const point = new Vec2(
				decodeCoordVal(c0) * StrokeFont.fontScale - startX,
				(decodeCoordVal(c1) + StrokeFont.fontOffset) * StrokeFont.fontScale
			);

			if (points == null) {
				points = [];
				strokes.push(points);
			}

			minY = Math.min(minY, point.y);
			maxY = Math.max(maxY, point.y);

			points.push(point);
		}
	}

	const bb = new BBox(0, minY, width, maxY - minY);
	return new StrokeGlyph(strokes, bb);
}
