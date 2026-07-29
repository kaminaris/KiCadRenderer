/*
	Ported from kicanvas (https://github.com/theacodes/kicanvas), MIT License.
	Copyright (c) 2023 Alethea Katherine Flowers.
	Full text available at: https://opensource.org/licenses/MIT
*/

import { Angle } from '../math/Angle';
import { BBox } from '../math/BBox';
import { Vec2 } from '../math/Vec2';

/**
 * Glyph abstract base class
 *
 * Shared between stroke and outline fonts, although outline fonts aren't
 * currently implemented.
 */
export abstract class Glyph {
	abstract transform(
		glyphSize: Vec2,
		offset: Vec2,
		tilt: number,
		angle: Angle,
		mirror: boolean,
		origin: Vec2
	): Glyph;

	abstract get bbox(): BBox;
}
