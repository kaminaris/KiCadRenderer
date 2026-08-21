/*
    Ported from kicanvas (https://github.com/theacodes/kicanvas), MIT License.
    Copyright (c) 2023 Alethea Katherine Flowers.
    Full text available at: https://opensource.org/licenses/MIT
*/
import { Glyph } from './Glyph';
/**
 * Glyphs for stroke fonts.
 */
export class StrokeGlyph extends Glyph {
    strokes;
    bbox;
    constructor(strokes, bbox) {
        super();
        this.strokes = strokes;
        this.bbox = bbox;
    }
    transform(glyphSize, offset, tilt, angle, mirror, origin) {
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
        const strokes = [];
        for (const srcStroke of this.strokes) {
            const points = [];
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
