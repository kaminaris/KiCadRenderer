import { Angle } from '../math/Angle';
import { Vec2 } from '../math/Vec2';
import { StrokeFont } from '../text/StrokeFont';
import { unescapeKicadString } from './KicadStringEscapes';
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
const emptyRunStyle = { overbar: false, subscript: false, superscript: false };
/**
 * Finds the `}` matching the `{` at `openIdx` (text[openIdx] === '{'),
 * counting nested braces of ANY kind so a nested `^{}`/`_{}`/`~{}` run
 * inside this one doesn't prematurely close it. Real KiCad's grammar
 * (include/markup_parser.h) also allows a bare `{identifier}` escape
 * sequence inside markup content (used for embedding a literal brace pair
 * without it being read as more markup) — generic depth-counting handles
 * that case's braces correctly for matching purposes too, it just doesn't
 * unwrap/strip it the way real KiCad's parser would (an obscure, rarely-used
 * feature, left as a known gap: the braces render literally instead of
 * being consumed).
 */
function findMatchingBrace(text, openIdx) {
    let depth = 1;
    for (let i = openIdx + 1; i < text.length; i++) {
        if (text[i] === '{') {
            depth++;
        }
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}
/**
 * Parses KiCad's inline text markup — `^{superscript}`, `_{subscript}`,
 * `~{overbar}` (include/markup_parser.h's `sor<subscript, superscript,
 * overbar>` grammar, applied to ALL text via common/font/font.cpp's
 * drawMarkup(), stroke font included, not just outline/TTF fonts) — into
 * flat plain-text runs each flagged with which styles apply. Markup nests
 * (e.g. `~{A^{B}}` overbars "A" and superscripts+overbars "B") — child style
 * flags accumulate with the parent's, matching drawMarkup's own `textStyle |=
 * ...` accumulation down the parse tree. StrokeFont.getTextAsGlyphs() already
 * draws all three independently (and in combination) per run — this is just
 * the markup-to-runs split, one call only draws one style combo at a time.
 *
 * Known gap vs. the real grammar: the `{identifier}` brace-escape sequence
 * (see findMatchingBrace's doc comment) isn't unwrapped — an obscure feature
 * with unclear real-world usage, not implemented.
 */
function parseMarkupRuns(text, style = emptyRunStyle) {
    const runs = [];
    let i = 0;
    let plainStart = 0;
    const flushPlain = (to) => {
        if (to > plainStart) {
            runs.push({ text: text.slice(plainStart, to), ...style });
        }
    };
    while (i < text.length) {
        const c = text[i];
        if ((c === '^' || c === '_' || c === '~') && text[i + 1] === '{') {
            const close = findMatchingBrace(text, i + 1);
            if (close !== -1) {
                flushPlain(i);
                const childStyle = {
                    overbar: style.overbar || c === '~',
                    subscript: style.subscript || c === '_',
                    superscript: style.superscript || c === '^',
                };
                runs.push(...parseMarkupRuns(text.slice(i + 2, close), childStyle));
                i = close + 1;
                plainStart = i;
                continue;
            }
        }
        i++;
    }
    flushPlain(text.length);
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
function layoutRuns(font, runs, size, position, angle, mirror, origin, italic = false) {
    const glyphs = [];
    let cursor = position;
    let bboxEnd = position;
    for (const run of runs) {
        const laid = font.getTextAsGlyphs(run.text, size, cursor, angle, mirror, origin, {
            overbar: run.overbar, subscript: run.subscript, superscript: run.superscript, italic,
        });
        glyphs.push(...laid.glyphs);
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
export function measureStrokeTextSize(text, sizeMm) {
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
    const runs = parseMarkupRuns(unescapeKicadString(text));
    const measured = layoutRuns(font, runs, size, new Vec2(0, 0), new Angle(0), false, new Vec2(0, 0));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const glyph of measured.glyphs) {
        for (const points of glyph.strokes) {
            for (const p of points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
        }
    }
    const width = maxX > minX ? maxX - minX : measured.bboxEnd.x;
    const height = maxY > minY ? maxY - minY : measured.bboxEnd.y;
    return { width: width || sizeMm, height: height || sizeMm };
}
export function getStrokeTextBounds(geometry) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of geometry.strokes) {
        for (const point of stroke.points) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }
    }
    for (const dot of geometry.dots) {
        minX = Math.min(minX, dot.center.x - dot.radius);
        minY = Math.min(minY, dot.center.y - dot.radius);
        maxX = Math.max(maxX, dot.center.x + dot.radius);
        maxY = Math.max(maxY, dot.center.y + dot.radius);
    }
    if (!Number.isFinite(minX)) {
        return { x: 0, y: 0, w: 0, h: 0 };
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
// KiCad's Font::interline_pitch_ratio — vertical spacing between stacked
// lines of a multiline text item, as a multiple of the font's own size.
const interlinePitchRatio = 1.62;
/** Multiline text (KiCad text items always support embedded `\n` line
 * breaks — this is unconditional in EDA_TEXT, not an opt-in flag) is laid
 * out by stacking each line `interline` apart, then anchoring the WHOLE
 * BLOCK vertically (top/center/bottom) while each line still gets its own
 * horizontal anchor against its own width — ports KiCad's
 * Font::get_line_positions(). Single-line text is just this loop running
 * once, so it degenerates to the exact same math the old single-line-only
 * implementation used (verified: with one line at offset 0, this produces
 * bit-identical results). */
export function computeStrokeTextGeometry(text, position, sizeMm, angleDeg, mirror, strokeWidthMm = 0.15, anchor = { x: 0, y: 0 }, italic = false) {
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
    const lines = rawLines.map((line, i) => {
        const runs = parseMarkupRuns(line);
        const measured = layoutRuns(font, runs, size, new Vec2(0, i * interline), new Angle(0), mirror, new Vec2(0, i * interline), italic);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const glyph of measured.glyphs) {
            for (const points of glyph.strokes) {
                for (const p of points) {
                    minX = Math.min(minX, p.x);
                    minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x);
                    maxY = Math.max(maxY, p.y);
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
    const allGlyphs = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
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
        const layoutPosition = new Vec2(position.x + (localY * sin + localShiftX * cos), position.y + (localY * cos - localShiftX * sin));
        const { glyphs } = layoutRuns(font, line.runs, size, layoutPosition, Angle.fromDegrees(angleDeg), mirror, layoutPosition, italic);
        allGlyphs.push(...glyphs);
    }
    const smallStrokeThreshold = sizeMm * smallStrokeBboxThreshold;
    const dotRadius = sizeMm * dotRadiusFactor;
    const strokes = [];
    const dots = [];
    for (const glyph of allGlyphs) {
        for (const points of glyph.strokes) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sumX = 0, sumY = 0;
            for (const p of points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
                sumX += p.x;
                sumY += p.y;
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
export function drawStrokeTextGeometry(renderer, geometry, color) {
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
export function paintStrokeText(renderer, text, position, sizeMm, angleDeg, mirror, color, strokeWidthMm = 0.15) {
    const geometry = computeStrokeTextGeometry(text, position, sizeMm, angleDeg, mirror, strokeWidthMm);
    drawStrokeTextGeometry(renderer, geometry, color);
}
