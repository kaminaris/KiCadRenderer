/*
	Ported from kicanvas (https://github.com/theacodes/kicanvas), MIT License.
	Copyright (c) 2023 Alethea Katherine Flowers.
	Full text available at: https://opensource.org/licenses/MIT
*/

import { Angle } from '../math/Angle';
import { BBox } from '../math/BBox';
import { Vec2 } from '../math/Vec2';
import { Glyph } from './Glyph';

type Stroke = Vec2[];

/**
 * Glyphs for stroke fonts.
 */
export class StrokeGlyph extends Glyph {
	constructor(
		public strokes: Stroke[],
		public bbox: BBox
	) {
		super();
	}

	override transform(
		glyphSize: Vec2,
		offset: Vec2,
		tilt: number,
		angle: Angle,
		mirror: boolean,
		origin: Vec2
	): StrokeGlyph {
		// Note: our bbox calculation differs from KiCAD's, however,
		// when I wrote this it seems to be consistent in terms of final
		// outcome.
		const bb = this.bbox.copy();

		bb.x = offset.x + bb.x * glyphSize.x;
		bb.y = offset.y + bb.y * glyphSize.y;
		bb.w = bb.w * glyphSize.x;
		bb.h = bb.h * glyphSize.y;

		if (tilt) {
			bb.w += bb.h * tilt;
		}

		const strokes: Stroke[] = [];

		for (const srcStroke of this.strokes) {
			const points: Vec2[] = [];
			for (const srcPoint of srcStroke) {
				let point = srcPoint.multiply(glyphSize);

				if (tilt > 0) {
					point.x -= point.y * tilt;
				}

				point = point.add(offset);

				if (mirror) {
					point.x = origin.x - (point.x - origin.x);
				}

				if (angle.degrees != 0) {
					point = angle.rotatePoint(point, origin);
				}

				points.push(point);
			}
			strokes.push(points);
		}

		return new StrokeGlyph(strokes, bb);
	}
}
