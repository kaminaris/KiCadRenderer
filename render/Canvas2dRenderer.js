/**
 * Direct Canvas2D primitive renderer. No retained scene graph, no per-node
 * texture caching, no resolution reassignment on interaction — geometry is
 * computed once (see paint/BoardPainter.ts) and this just replays it
 * against the current camera transform every frame. See the design
 * discussion in-thread for why this is deliberately simpler than the
 * previous PixiJS attempt.
 *
 * Batch mode: a board like GigaMicroEPCV2 has 6700+ paintable items, and
 * profiling showed the dominant per-frame cost once glyph decoding was
 * cached (see TextPaint.ts) wasn't pixel-fill work but the sheer NUMBER of
 * individual beginPath/fill/stroke Canvas2D calls — each carries its own
 * fixed overhead regardless of how few pixels it touches. Between
 * beginBatch()/endBatch(), every primitive call here appends its geometry
 * to a Path2D bucketed by exact style (fillColor+rule, or
 * strokeColor+width) instead of drawing immediately; endBatch() then does
 * ONE fill()/stroke() per distinct style. A layer with a thousand
 * same-colored pads collapses to a single fill() call instead of a
 * thousand. Outside a batch, behavior is unchanged (immediate draw) — used
 * by callers like the grid, which redraw fresh dot-by-dot every frame and
 * don't share a style worth batching.
 *
 * @deprecated Kept only as KicadRenderSession's automatic fallback for
 * environments where WebGL context creation genuinely fails (disabled GPU,
 * headless CI, locked-down browser policy) — see the constructor's try/catch
 * around `new WebGLRenderer(canvasGl)`. Even with the batching above, this
 * still re-rasterizes the ENTIRE visible scene on the CPU every single pan/
 * zoom frame (no persisted GPU buffers), which is the documented ceiling
 * that motivated WebGLRenderer in the first place — see its own class
 * comment. Don't build new features against this renderer or start a
 * session with `canvasGl: null`; use WebGLRenderer via a real WebGL canvas.
 */
export class Canvas2dRenderer {
    ctx;
    batching = false;
    fillBatches = new Map();
    strokeBatches = new Map();
    images = new Map();
    imageLoadHandler = null;
    constructor(ctx) {
        this.ctx = ctx;
    }
    setOpacity(opacity) {
        this.ctx.globalAlpha = opacity;
    }
    setImageLoadHandler(handler) {
        this.imageLoadHandler = handler;
    }
    setViewMatrix(matrix) {
        this.ctx.setTransform(matrix.toDOMMatrix());
    }
    clear(color) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.fillStyle = color;
        this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    }
    // Canvas2D already commits everything at endBatch() (see below) — there's
    // no separate frame-level buffer to flush the way WebGLRenderer has.
    flush() { }
    beginBatch() {
        this.batching = true;
        this.fillBatches.clear();
        this.strokeBatches.clear();
    }
    /** Commits every accumulated style bucket with one fill()/stroke() call each. */
    endBatch() {
        this.batching = false;
        this.commitBatches();
    }
    /** Draw the currently accumulated vector paths without ending batch mode.
     * An image is an immediate Canvas operation, so this preserves exact paint
     * order when it appears between otherwise batched vector items. */
    commitBatches() {
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        for (const batch of this.fillBatches.values()) {
            this.ctx.fillStyle = batch.color;
            this.ctx.fill(batch.path, batch.rule);
        }
        for (const batch of this.strokeBatches.values()) {
            this.ctx.strokeStyle = batch.color;
            this.ctx.lineWidth = batch.width;
            this.ctx.stroke(batch.path);
        }
        this.fillBatches.clear();
        this.strokeBatches.clear();
    }
    // Map keys here are only ever used to find/merge an existing batch —
    // the color actually applied at commit time comes from batch.color,
    // stored explicitly (see endBatch()). An earlier version tried to
    // recover the color by reading the map KEY back at commit time; the key
    // carries extra suffix data (fill rule / stroke width) appended to it,
    // which made that string an invalid CSS color — ctx.fillStyle silently
    // ignores invalid assignments per spec (same failure class as the
    // ctx.lineWidth=0 bug from earlier in this project), so fills were
    // silently using whatever fillStyle happened to be left on the context
    // from something unrelated. Storing color explicitly on the batch
    // sidesteps needing to parse it back out of anything.
    getFillBatch(color, rule) {
        const key = `${color}|${rule}`;
        let batch = this.fillBatches.get(key);
        if (!batch) {
            batch = { path: new Path2D(), rule, color };
            this.fillBatches.set(key, batch);
        }
        return batch.path;
    }
    getStrokeBatch(color, width) {
        const key = `${color}|${width}`;
        let batch = this.strokeBatches.get(key);
        if (!batch) {
            batch = { path: new Path2D(), width, color };
            this.strokeBatches.set(key, batch);
        }
        return batch.path;
    }
    // Whether this style actually wants a stroke drawn. Deliberately NOT just
    // `!!style.strokeColor` — Canvas2D silently ignores `ctx.lineWidth = 0`
    // (invalid per spec, the previous value is left unchanged), so a style
    // with strokeColor set but no positive strokeWidth would inherit
    // whatever lineWidth some earlier, unrelated draw call happened to leave
    // on the context. That's what made pads render oversized: they set
    // strokeColor == fillColor with no strokeWidth, and picked up whatever
    // track width was drawn most recently. Filled shapes that don't want a
    // distinct edge should just omit strokeColor entirely.
    wantsStroke(style) {
        return !!style.strokeColor && !!style.strokeWidth && style.strokeWidth > 0;
    }
    applyStyle(style, filled) {
        if (this.wantsStroke(style)) {
            this.ctx.strokeStyle = style.strokeColor;
            this.ctx.lineWidth = style.strokeWidth;
        }
        if (filled && style.fillColor) {
            this.ctx.fillStyle = style.fillColor;
        }
    }
    line(points, style) {
        if (points.length < 2) {
            return;
        }
        if (this.batching) {
            if (!this.wantsStroke(style)) {
                return;
            }
            const path = this.getStrokeBatch(style.strokeColor, style.strokeWidth);
            path.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                path.lineTo(points[i].x, points[i].y);
            }
            return;
        }
        this.applyStyle(style, false);
        // KiCad tracks/wires always have rounded end-caps and joins (a track
        // segment is a "stadium" shape, not a bare rectangle) — Canvas2D's
        // default lineCap is 'butt', which is what produced the square-ended
        // traces. capStyle: 'butt' opts back out for callers that explicitly
        // don't want that (see RenderStyle.capStyle's doc comment) — ratsnest
        // airwires, specifically, which real KiCad draws flat-ended.
        this.ctx.lineCap = style.capStyle === 'butt' ? 'butt' : 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            this.ctx.lineTo(points[i].x, points[i].y);
        }
        if (this.wantsStroke(style)) {
            this.ctx.stroke();
        }
    }
    polygon(points, style) {
        if (points.length < 3) {
            return;
        }
        const filled = !!style.fillColor;
        if (this.batching) {
            if (filled) {
                const fillPath = this.getFillBatch(style.fillColor, 'nonzero');
                this.appendRing(fillPath, points);
            }
            if (this.wantsStroke(style)) {
                const strokePath = this.getStrokeBatch(style.strokeColor, style.strokeWidth);
                this.appendRing(strokePath, points);
            }
            return;
        }
        this.applyStyle(style, filled);
        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            this.ctx.lineTo(points[i].x, points[i].y);
        }
        this.ctx.closePath();
        if (filled) {
            this.ctx.fill();
        }
        if (this.wantsStroke(style)) {
            this.ctx.stroke();
        }
    }
    circle(center, radius, style) {
        const filled = !!style.fillColor;
        if (this.batching) {
            // Path2D.arc() draws a connecting line from wherever the path's
            // current point is to the arc's own start point UNLESS a moveTo
            // immediately precedes it — with many circles accumulated into one
            // shared batched path, omitting this silently strings every
            // circle in the batch together with stray chord lines, which
            // under nonzero fill can black out huge swaths between unrelated
            // shapes. moveTo to the arc's own start angle (0 rad = +x) makes
            // that connecting segment zero-length, i.e. a genuine no-op.
            if (filled) {
                const path = this.getFillBatch(style.fillColor, 'nonzero');
                path.moveTo(center.x + radius, center.y);
                path.arc(center.x, center.y, radius, 0, Math.PI * 2);
            }
            if (this.wantsStroke(style)) {
                const path = this.getStrokeBatch(style.strokeColor, style.strokeWidth);
                path.moveTo(center.x + radius, center.y);
                path.arc(center.x, center.y, radius, 0, Math.PI * 2);
            }
            return;
        }
        this.applyStyle(style, filled);
        this.ctx.beginPath();
        this.ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        if (filled) {
            this.ctx.fill();
        }
        if (this.wantsStroke(style)) {
            this.ctx.stroke();
        }
    }
    arc(center, radius, startAngleRad, endAngleRad, style) {
        if (this.batching) {
            if (this.wantsStroke(style)) {
                // Same connecting-line hazard as circle() above — moveTo the
                // arc's actual start point first.
                const path = this.getStrokeBatch(style.strokeColor, style.strokeWidth);
                path.moveTo(center.x + radius * Math.cos(startAngleRad), center.y + radius * Math.sin(startAngleRad));
                path.arc(center.x, center.y, radius, startAngleRad, endAngleRad);
            }
            return;
        }
        this.applyStyle(style, false);
        this.ctx.beginPath();
        this.ctx.arc(center.x, center.y, radius, startAngleRad, endAngleRad);
        if (this.wantsStroke(style)) {
            this.ctx.stroke();
        }
    }
    multiPolygon(rings, style) {
        const filled = !!style.fillColor;
        if (this.batching) {
            // Even-odd glyph rings must never share a Path2D with a plain
            // nonzero-filled shape of the same color (unrelated geometry
            // could accidentally cancel a letter's counter-hole) — passing
            // 'evenodd' as part of the batch key already guarantees a
            // separate bucket from any 'nonzero' fill of the same color, no
            // extra color-string tagging needed.
            if (filled) {
                const fillPath = this.getFillBatch(style.fillColor, 'evenodd');
                for (const ring of rings) {
                    this.appendRing(fillPath, ring);
                }
            }
            if (this.wantsStroke(style)) {
                const strokePath = this.getStrokeBatch(style.strokeColor, style.strokeWidth);
                for (const ring of rings) {
                    this.appendRing(strokePath, ring);
                }
            }
            return;
        }
        this.applyStyle(style, filled);
        this.ctx.beginPath();
        for (const ring of rings) {
            if (ring.length < 3) {
                continue;
            }
            this.ctx.moveTo(ring[0].x, ring[0].y);
            for (let i = 1; i < ring.length; i++) {
                this.ctx.lineTo(ring[i].x, ring[i].y);
            }
            this.ctx.closePath();
        }
        if (filled) {
            this.ctx.fill('evenodd');
        }
        if (this.wantsStroke(style)) {
            this.ctx.stroke();
        }
    }
    rect(topLeft, width, height, style) {
        const filled = !!style.fillColor;
        if (this.batching) {
            if (filled) {
                this.getFillBatch(style.fillColor, 'nonzero').rect(topLeft.x, topLeft.y, width, height);
            }
            if (this.wantsStroke(style)) {
                this.getStrokeBatch(style.strokeColor, style.strokeWidth).rect(topLeft.x, topLeft.y, width, height);
            }
            return;
        }
        this.applyStyle(style, filled);
        if (filled) {
            this.ctx.fillRect(topLeft.x, topLeft.y, width, height);
        }
        if (this.wantsStroke(style)) {
            this.ctx.strokeRect(topLeft.x, topLeft.y, width, height);
        }
    }
    image(image, topLeft, width, height, corners) {
        let bitmap = this.images.get(image.data);
        if (!bitmap) {
            bitmap = new Image();
            bitmap.onload = () => this.imageLoadHandler?.();
            bitmap.onerror = () => this.imageLoadHandler?.();
            bitmap.src = `data:${image.mimeType};base64,${btoa(image.data)}`;
            this.images.set(image.data, bitmap);
        }
        if (!bitmap.complete || !bitmap.naturalWidth) {
            return;
        }
        if (this.batching) {
            this.commitBatches();
        }
        if (!corners) {
            this.ctx.drawImage(bitmap, topLeft.x, topLeft.y, width, height);
            return;
        }
        const [topLeftCorner, topRight, bottomLeft] = corners;
        this.ctx.save();
        this.ctx.transform((topRight.x - topLeftCorner.x) / width, (topRight.y - topLeftCorner.y) / width, (bottomLeft.x - topLeftCorner.x) / height, (bottomLeft.y - topLeftCorner.y) / height, topLeftCorner.x, topLeftCorner.y);
        this.ctx.drawImage(bitmap, 0, 0, width, height);
        this.ctx.restore();
    }
    appendRing(path, points) {
        if (points.length < 3) {
            return;
        }
        path.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            path.lineTo(points[i].x, points[i].y);
        }
        path.closePath();
    }
}
