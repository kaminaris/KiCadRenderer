import { Vec2 } from '../math/Vec2';
import { Matrix3 } from '../math/Matrix3';
const vertexShaderSource = `
	attribute vec2 aPosition;
	attribute vec4 aColor;
	uniform mat3 uMatrix;
	varying vec4 vColor;
	void main() {
		vec3 clip = uMatrix * vec3(aPosition, 1.0);
		gl_Position = vec4(clip.xy, 0.0, 1.0);
		vColor = aColor;
	}
`;
const fragmentShaderSource = `
	precision mediump float;
	varying vec4 vColor;
	void main() {
		gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
	}
`;
const imageVertexShaderSource = `
	attribute vec2 aPosition;
	attribute vec2 aTexCoord;
	uniform mat3 uMatrix;
	varying vec2 vTexCoord;
	void main() {
		vec3 clip = uMatrix * vec3(aPosition, 1.0);
		gl_Position = vec4(clip.xy, 0.0, 1.0);
		vTexCoord = aTexCoord;
	}
`;
const imageFragmentShaderSource = `
	precision mediump float;
	varying vec2 vTexCoord;
	uniform sampler2D uTexture;
	uniform float uOpacity;
	void main() {
		vec4 color = texture2D(uTexture, vTexCoord);
		gl_FragColor = vec4(color.rgb * color.a * uOpacity, color.a * uOpacity);
	}
`;
/**
 * WebGL primitive renderer — same Renderer interface as Canvas2dRenderer, so
 * BoardPainter's item-building logic is untouched; only the drawing backend
 * changes. Built after Canvas2D hit a real, structural ceiling on dense
 * boards: even with per-layer draw-call batching, Canvas2D still does
 * CPU-side rasterization per fill()/stroke() call. WebGL uploads geometry
 * once and rasterizes on the GPU, in parallel — the same reason kicanvas
 * uses it.
 *
 * The critical design point (a first version of this got badly wrong, see
 * in-thread discussion): tessellating shapes into triangles — computing
 * circle points, expanding strokes into quads, building glyph fans — is
 * real CPU work in JavaScript. Doing that over on EVERY frame, the same way
 * the draw() closures get replayed every frame for Canvas2D, defeats the
 * entire point of using the GPU — it's then strictly slower than Canvas2D
 * for the same workload, since it adds tessellation cost Canvas2D's native
 * primitives don't pay.
 *
 * So geometry here is split into two buffers with different lifetimes:
 *  - STATIC: the board scene itself. Built ONCE (via
 *    beginStaticBuild()/endStaticBuild(), driven by BoardPainter.paint())
 *    and uploaded to a persistent GPU buffer. Panning, zooming, and
 *    flipping the view do NOT touch this buffer at all — only the camera's
 *    view-matrix UNIFORM changes, and draw() just re-issues the same
 *    already-uploaded vertices against the new matrix. Rebuilt only when
 *    the actual scene content changes: layer visibility/opacity, or a new
 *    board loaded — NOT board selection, which used to rebuild this whole
 *    buffer just to recolor 1-2 items (the same cost as a fresh board
 *    load, on every click) until it was moved to the dynamic tier below
 *    (see BoardPainter.paintHighlightOverlay's doc comment). Schematic
 *    selection is the one remaining exception, still baked in here —
 *    unlike PCB boards, not yet moved to the dynamic path.
 *  - DYNAMIC: small per-frame content that genuinely changes every frame
 *    (the grid, ratsnest, drag/edit previews, board selection highlight,
 *    selection handles).
 *    Cheap enough to fully re-tessellate every frame since it's a few
 *    hundred shapes, not thousands of board items. Drawn in TWO passes —
 *    grid first via flush() (drawn behind everything, then the static
 *    scene on top of it), then everything else via a second
 *    beginDynamicFrame()/flushOverlay() pass AFTER the static scene is
 *    already on screen, so overlay content actually ends up on top of it
 *    instead of underneath (see KicadRenderSession.render() and
 *    Renderer.flushOverlay's doc comment).
 *

 * Even-odd glyph fills (render_cache text) are part of the STATIC set too —
 * each gets its own small "stencil, then cover" pair of GPU buffers, built
 * once in endStaticBuild() and just bound-and-drawn (no CPU work) every
 * frame in draw().
 */
export class WebGLRenderer {
    gl;
    program;
    matrixLocation;
    positionLocation;
    colorLocation;
    imageProgram;
    imageMatrixLocation;
    imagePositionLocation;
    imageTexCoordLocation;
    imageTextureLocation;
    imageOpacityLocation;
    staticPositionBuffer;
    staticColorBuffer;
    // Ordered so z-order between regular (fan/quad) geometry and stencil
    // (even-odd, e.g. zone fill) geometry is preserved. Drawing "all regular
    // geometry, then all stencil jobs" (an earlier version of this file did
    // exactly that) is WRONG whenever anything drawn later in paint order —
    // like a via, which sits on the always-on-top 'Vias' layer — is
    // supposed to sit on top of a zone fill: the zone would always win
    // regardless of true paint order, since every stencil job got shoved to
    // the end. Each command references a CONTIGUOUS vertex range of the one
    // uploaded static buffer (regular) or a baked stencil job (even-odd).
    staticCommands = [];
    dynamicPositionBuffer;
    dynamicColorBuffer;
    // Accumulation targets while a build is in progress — swapped between
    // the static and dynamic arrays depending on which build is active.
    buildPositions = [];
    buildColors = [];
    buildCommands = [];
    pendingRegularStart = 0;
    buildingStatic = false;
    // Persistent CPU mirror of what's actually uploaded to
    // staticPositionBuffer/staticColorBuffer — kept alive PAST
    // endStaticBuild() (unlike buildPositions/buildColors, which reset for
    // the next accumulation cycle) specifically so translateStaticItems()
    // can mutate a small slice of it and re-upload just that slice via
    // bufferSubData, without needing to re-run any item's draw() closure.
    staticPositions = [];
    staticColors = [];
    // Per-item tracking for translateStaticItems() — see beginItem()'s own
    // doc comment (Renderer.ts) for what this is for. Keyed by PaintedItem
    // id, valid only until the next beginStaticBuild() (which clears it,
    // since every array index it references is about to be invalidated).
    itemRanges = new Map();
    hiddenItemColors = new Map();
    currentItemId = null;
    currentItemPosStart = 0;
    currentItemStencilIndices = [];
    currentItemImageIndices = [];
    // Raw (pre-bake) ring/color/bbox data for each baked stencil job, keyed
    // by its OWN index into staticCommands — bakeStencilJob() only produces
    // opaque GL buffers with no way to read their contents back (not
    // cheaply possible in WebGL1), so translating a stencil job means
    // re-deriving its geometry from this instead of the baked buffers.
    stencilSourceByCommandIndex = new Map();
    imageSourceByCommandIndex = new Map();
    currentOpacity = 1;
    viewMatrix = Matrix3.identity();
    images = new Map();
    imageLoadHandler = null;
    constructor(canvas) {
        const gl = canvas.getContext('webgl', { stencil: true, antialias: true });
        if (!gl) {
            throw new Error('WebGL is not available in this browser');
        }
        this.gl = gl;
        const vs = this.compileShader(gl.VERTEX_SHADER, vertexShaderSource);
        const fs = this.compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(program)}`);
        }
        this.program = program;
        const imageVs = this.compileShader(gl.VERTEX_SHADER, imageVertexShaderSource);
        const imageFs = this.compileShader(gl.FRAGMENT_SHADER, imageFragmentShaderSource);
        const imageProgram = gl.createProgram();
        gl.attachShader(imageProgram, imageVs);
        gl.attachShader(imageProgram, imageFs);
        gl.linkProgram(imageProgram);
        if (!gl.getProgramParameter(imageProgram, gl.LINK_STATUS)) {
            throw new Error(`WebGL image program link failed: ${gl.getProgramInfoLog(imageProgram)}`);
        }
        this.imageProgram = imageProgram;
        this.staticPositionBuffer = gl.createBuffer();
        this.staticColorBuffer = gl.createBuffer();
        this.dynamicPositionBuffer = gl.createBuffer();
        this.dynamicColorBuffer = gl.createBuffer();
        this.positionLocation = gl.getAttribLocation(program, 'aPosition');
        this.colorLocation = gl.getAttribLocation(program, 'aColor');
        this.matrixLocation = gl.getUniformLocation(program, 'uMatrix');
        this.imagePositionLocation = gl.getAttribLocation(imageProgram, 'aPosition');
        this.imageTexCoordLocation = gl.getAttribLocation(imageProgram, 'aTexCoord');
        this.imageMatrixLocation = gl.getUniformLocation(imageProgram, 'uMatrix');
        this.imageTextureLocation = gl.getUniformLocation(imageProgram, 'uTexture');
        this.imageOpacityLocation = gl.getUniformLocation(imageProgram, 'uOpacity');
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`WebGL shader compile failed: ${log}`);
        }
        return shader;
    }
    setOpacity(opacity) {
        this.currentOpacity = opacity;
    }
    setImageLoadHandler(handler) {
        this.imageLoadHandler = handler;
    }
    setViewMatrix(matrix) {
        this.viewMatrix = matrix;
    }
    clear(color) {
        const [r, g, b] = parseColor(color);
        const gl = this.gl;
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.clearColor(r, g, b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    }
    /** Start accumulating the board scene into the STATIC (upload-once) buffer. */
    beginStaticBuild() {
        this.buildingStatic = true;
        this.buildPositions.length = 0;
        this.buildColors.length = 0;
        this.buildCommands.length = 0;
        this.pendingRegularStart = 0;
        // Every array index itemRanges/stencilSourceByCommandIndex refers to
        // is about to be invalidated by this rebuild — a stale entry left
        // behind here would let a LATER translateStaticItems() call corrupt
        // unrelated geometry it now happens to alias.
        this.itemRanges.clear();
        this.hiddenItemColors.clear();
        this.stencilSourceByCommandIndex.clear();
        this.imageSourceByCommandIndex.clear();
        this.currentItemId = null;
    }
    /** See Renderer.beginItem's own doc comment. */
    beginItem(id) {
        if (!this.buildingStatic) {
            return;
        }
        this.currentItemId = id;
        this.currentItemPosStart = this.buildPositions.length;
        this.currentItemStencilIndices = [];
        this.currentItemImageIndices = [];
    }
    endItem() {
        if (!this.buildingStatic || this.currentItemId === null) {
            return;
        }
        this.itemRanges.set(this.currentItemId, {
            posStart: this.currentItemPosStart,
            posEnd: this.buildPositions.length,
            stencilCmdIndices: this.currentItemStencilIndices,
            imageCmdIndices: this.currentItemImageIndices,
        });
        this.currentItemId = null;
    }
    /** Closes out whatever regular-geometry range has accumulated since the
     * last command, right before a stencil job needs to be interleaved (or
     * at the very end of the build) — see the staticCommands field comment. */
    flushPendingRegular() {
        const end = this.buildPositions.length / 2;
        const count = end - this.pendingRegularStart;
        if (count > 0) {
            this.buildCommands.push({ kind: 'regular', start: this.pendingRegularStart, count });
        }
        this.pendingRegularStart = end;
    }
    /** Uploads everything accumulated since beginStaticBuild() to persistent GPU buffers. */
    endStaticBuild() {
        this.flushPendingRegular();
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.staticPositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.buildPositions), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.staticColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.buildColors), gl.STATIC_DRAW);
        for (const cmd of this.staticCommands) {
            if (cmd.kind === 'stencil') {
                gl.deleteBuffer(cmd.job.fanPositionBuffer);
                gl.deleteBuffer(cmd.job.quadPositionBuffer);
            }
            else if (cmd.kind === 'image') {
                gl.deleteBuffer(cmd.job.positionBuffer);
                gl.deleteBuffer(cmd.job.texCoordBuffer);
            }
        }
        this.staticCommands = this.buildCommands.map((cmd, index) => {
            if (cmd.kind === 'stencil') {
                // Kept around (not just the baked GL buffers) so
                // translateStaticItems() can shift + re-tessellate this
                // job's own small geometry later without needing to read
                // GPU buffer contents back.
                this.stencilSourceByCommandIndex.set(index, cmd.job);
                return { kind: 'stencil', job: this.bakeStencilJob(cmd.job) };
            }
            if (cmd.kind === 'image') {
                this.imageSourceByCommandIndex.set(index, cmd.job);
                return { kind: 'image', job: this.bakeImageJob(cmd.job) };
            }
            return cmd;
        });
        // buildPositions/buildColors become the persistent CPU mirror of
        // what was just uploaded (see the fields' own doc comment) — a
        // FRESH array for the next accumulation cycle, not a clear of this
        // one, since a translateStaticItems() call can happen at any later
        // time, long before the next beginStaticBuild() touches these again.
        this.staticPositions = this.buildPositions;
        this.staticColors = this.buildColors;
        this.buildPositions = [];
        this.buildColors = [];
        this.buildingStatic = false;
        this.buildCommands.length = 0;
    }
    /**
     * See Renderer.translateStaticItems's own doc comment. All-or-nothing:
     * if ANY of the given ids can't be translated incrementally (never
     * part of a static build), nothing is mutated and this
     * returns false — a caller falling back to a full rebuild on partial
     * failure must not also be left with SOME items already moved.
     */
    translateStaticItems(ids, dx, dy) {
        const ranges = [];
        for (const id of ids) {
            const range = this.itemRanges.get(id);
            if (!range) {
                return false;
            }
            ranges.push(range);
        }
        if (ranges.length === 0) {
            return true;
        }
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.staticPositionBuffer);
        for (const range of ranges) {
            if (range.posEnd <= range.posStart) {
                continue;
            }
            for (let i = range.posStart; i < range.posEnd; i += 2) {
                this.staticPositions[i] = this.staticPositions[i] + dx;
                this.staticPositions[i + 1] = this.staticPositions[i + 1] + dy;
            }
            // Float32 = 4 bytes; posStart/posEnd are already flat float
            // indices (x,y pairs), not vertex counts.
            const byteOffset = range.posStart * 4;
            gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, new Float32Array(this.staticPositions.slice(range.posStart, range.posEnd)));
            for (const cmdIndex of range.stencilCmdIndices) {
                this.retranslateStencilJob(cmdIndex, dx, dy);
            }
            for (const cmdIndex of range.imageCmdIndices) {
                this.retranslateImageJob(cmdIndex, dx, dy);
            }
        }
        return true;
    }
    /** Temporarily hides ordinary static items by zeroing just their vertex
     * alpha. Track drags use this instead of rebuilding the entire board solely
     * to remove the original line underneath the dynamic drag preview. */
    setStaticItemsVisible(ids, visible) {
        const entries = [];
        for (const id of ids) {
            const range = this.itemRanges.get(id);
            if (!range || range.stencilCmdIndices.length > 0 || range.imageCmdIndices.length > 0) {
                return false;
            }
            entries.push({ id, range });
        }
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.staticColorBuffer);
        for (const { id, range } of entries) {
            const start = range.posStart * 2;
            const end = range.posEnd * 2;
            if (visible) {
                const colors = this.hiddenItemColors.get(id);
                if (!colors)
                    continue;
                this.staticColors.splice(start, end - start, ...colors);
                this.hiddenItemColors.delete(id);
            }
            else {
                if (this.hiddenItemColors.has(id))
                    continue;
                this.hiddenItemColors.set(id, this.staticColors.slice(start, end));
                for (let index = start + 3; index < end; index += 4)
                    this.staticColors[index] = 0;
            }
            gl.bufferSubData(gl.ARRAY_BUFFER, start * 4, new Float32Array(this.staticColors.slice(start, end)));
        }
        return true;
    }
    /** Re-derives one stencil job's geometry shifted by (dx, dy) from its
     *  retained raw source (see stencilSourceByCommandIndex's own doc
     *  comment) and re-bakes it — cheap, since one job is always a single
     *  small shape (a zone fill region, a custom pad, a concave graphic),
     *  never the whole board. Updates the retained source too, so a SECOND
     *  translateStaticItems() call later in the same drag composes
     *  correctly instead of re-deriving from the original (now stale)
     *  position. */
    retranslateStencilJob(cmdIndex, dx, dy) {
        const cmd = this.staticCommands[cmdIndex];
        if (!cmd || cmd.kind !== 'stencil') {
            return;
        }
        const source = this.stencilSourceByCommandIndex.get(cmdIndex);
        if (!source) {
            return;
        }
        const shifted = {
            rings: source.rings.map(ring => ring.map(p => new Vec2(p.x + dx, p.y + dy))),
            color: source.color,
            minX: source.minX + dx, minY: source.minY + dy,
            maxX: source.maxX + dx, maxY: source.maxY + dy,
        };
        const gl = this.gl;
        gl.deleteBuffer(cmd.job.fanPositionBuffer);
        gl.deleteBuffer(cmd.job.quadPositionBuffer);
        this.staticCommands[cmdIndex] = { kind: 'stencil', job: this.bakeStencilJob(shifted) };
        this.stencilSourceByCommandIndex.set(cmdIndex, shifted);
    }
    retranslateImageJob(cmdIndex, dx, dy) {
        const cmd = this.staticCommands[cmdIndex];
        const source = this.imageSourceByCommandIndex.get(cmdIndex);
        if (!cmd || cmd.kind !== 'image' || !source) {
            return;
        }
        const shifted = {
            ...source,
            x: source.x + dx,
            y: source.y + dy,
            corners: source.corners?.map(point => new Vec2(point.x + dx, point.y + dy)),
        };
        const gl = this.gl;
        gl.deleteBuffer(cmd.job.positionBuffer);
        gl.deleteBuffer(cmd.job.texCoordBuffer);
        this.staticCommands[cmdIndex] = { kind: 'image', job: this.bakeImageJob(shifted) };
        this.imageSourceByCommandIndex.set(cmdIndex, shifted);
    }
    bakeStencilJob(job) {
        const gl = this.gl;
        const fanPositions = [];
        for (const ring of job.rings) {
            const x0 = ring[0].x, y0 = ring[0].y;
            for (let i = 1; i < ring.length - 1; i++) {
                fanPositions.push(x0, y0, ring[i].x, ring[i].y, ring[i + 1].x, ring[i + 1].y);
            }
        }
        const fanPositionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, fanPositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fanPositions), gl.STATIC_DRAW);
        const quad = [
            job.minX, job.minY, job.maxX, job.minY, job.maxX, job.maxY,
            job.minX, job.minY, job.maxX, job.maxY, job.minX, job.maxY,
        ];
        const quadPositionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadPositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quad), gl.STATIC_DRAW);
        return { fanPositionBuffer, fanVertexCount: fanPositions.length / 2, quadPositionBuffer, color: job.color };
    }
    bakeImageJob(job) {
        const gl = this.gl;
        const corners = job.corners ?? [
            new Vec2(job.x, job.y), new Vec2(job.x + job.width, job.y),
            new Vec2(job.x + job.width, job.y + job.height), new Vec2(job.x, job.y + job.height),
        ];
        const positions = [
            corners[0].x, corners[0].y, corners[1].x, corners[1].y, corners[2].x, corners[2].y,
            corners[0].x, corners[0].y, corners[2].x, corners[2].y, corners[3].x, corners[3].y,
        ];
        // UNPACK_FLIP_Y_WEBGL makes v=0 correspond to the image's top row.
        const texCoords = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
        const texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texCoords), gl.STATIC_DRAW);
        return { positionBuffer, texCoordBuffer, texture: job.texture, opacity: job.opacity };
    }
    /** Start accumulating per-frame content (the grid) into the DYNAMIC buffer. */
    beginDynamicFrame() {
        this.buildingStatic = false;
        this.buildPositions.length = 0;
        this.buildColors.length = 0;
    }
    // Layer boundaries inside a build only matter for opacity (baked into
    // each vertex's own alpha, see pushVertex) — nothing else to do here.
    beginBatch() { }
    endBatch() { }
    line(points, style) {
        if (points.length < 2 || !this.wantsStroke(style)) {
            return;
        }
        this.pushStrokePolyline(points, style.strokeColor, style.strokeWidth, false, style.capStyle);
    }
    polygon(points, style) {
        if (points.length < 3) {
            return;
        }
        // Delegate to multiPolygon's stencil-based even-odd fill rather than
        // pushConvexFan — a schematic/symbol polygon is frequently CONCAVE
        // (e.g. a gear-shaped logo, an arrow, a star), and fanning a concave
        // ring from one arbitrary vertex produces triangles that stick
        // outside the true outline, visibly corrupting the fill. Text
        // glyphs already rely on this exact path for the same reason (a "G"
        // or "0" glyph is its own non-convex ring) — nothing convexity-
        // specific about it that would make it wrong for a single ring.
        this.multiPolygon([points], style);
    }
    circle(center, radius, style) {
        if (style.fillColor) {
            this.pushCircleFan(center.x, center.y, radius, style.fillColor);
        }
        if (this.wantsStroke(style)) {
            const ring = circlePoints(center, radius, segmentsForRadius(radius, MIN_CIRCLE_SEGMENTS, MAX_CIRCLE_SEGMENTS));
            this.pushStrokePolyline(ring, style.strokeColor, style.strokeWidth, true);
        }
    }
    arc(center, radius, startAngleRad, endAngleRad, style) {
        if (!this.wantsStroke(style)) {
            return;
        }
        const points = [];
        const fullCircleSegments = segmentsForRadius(radius, MIN_CIRCLE_SEGMENTS, MAX_CIRCLE_SEGMENTS);
        const steps = Math.max(4, Math.ceil((Math.abs(endAngleRad - startAngleRad) / (Math.PI * 2)) * fullCircleSegments));
        for (let i = 0; i <= steps; i++) {
            const t = startAngleRad + ((endAngleRad - startAngleRad) * i) / steps;
            points.push(new Vec2(center.x + radius * Math.cos(t), center.y + radius * Math.sin(t)));
        }
        this.pushStrokePolyline(points, style.strokeColor, style.strokeWidth, false);
    }
    rect(topLeft, width, height, style) {
        const x0 = topLeft.x, y0 = topLeft.y, x1 = topLeft.x + width, y1 = topLeft.y + height;
        if (style.fillColor) {
            // Pushes the two triangles' 6 vertices directly instead of going
            // through pushConvexFan (which needs a Vec2[] to iterate) — worth
            // avoiding the array/object allocation specifically here because
            // the grid draws this in a per-frame loop that can run tens of
            // thousands of times (one rect per grid dot).
            const color = parseColor(style.fillColor);
            this.buildPositions.push(x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1);
            for (let i = 0; i < 6; i++) {
                this.buildColors.push(color[0], color[1], color[2], color[3] * this.currentOpacity);
            }
        }
        if (this.wantsStroke(style)) {
            const corners = [new Vec2(x0, y0), new Vec2(x1, y0), new Vec2(x1, y1), new Vec2(x0, y1)];
            this.pushStrokePolyline(corners, style.strokeColor, style.strokeWidth, true);
        }
    }
    image(image, topLeft, width, height, corners) {
        if (!this.buildingStatic || !(width > 0) || !(height > 0)) {
            return;
        }
        const record = this.loadImage(image);
        if (record.status !== 'ready') {
            return;
        }
        const texture = record.texture ?? this.createTexture(record.image);
        record.texture = texture;
        // Keep image draw calls interleaved with regular vector geometry instead
        // of drawing all textures in a final overlay pass.
        this.flushPendingRegular();
        this.buildCommands.push({ kind: 'image', job: { texture, x: topLeft.x, y: topLeft.y, width, height, corners, opacity: this.currentOpacity } });
        if (this.currentItemId !== null) {
            this.currentItemImageIndices.push(this.buildCommands.length - 1);
        }
    }
    loadImage(source) {
        let record = this.images.get(source.data);
        if (record) {
            return record;
        }
        const image = new Image();
        record = { image, status: 'loading' };
        image.onload = () => {
            record.status = 'ready';
            this.imageLoadHandler?.();
        };
        image.onerror = () => {
            record.status = 'error';
            this.imageLoadHandler?.();
        };
        image.src = `data:${source.mimeType};base64,${btoa(source.data)}`;
        this.images.set(source.data, record);
        return record;
    }
    createTexture(image) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return texture;
    }
    multiPolygon(rings, style) {
        const usableRings = rings.filter(r => r.length >= 3);
        if (usableRings.length === 0) {
            return;
        }
        if (style.fillColor) {
            // parseColor's 4th element is the color string's OWN alpha (e.g.
            // zone fills bake ZONE_FILL_ALPHA into an rgba() string via
            // LayerColors.withAlpha()) — discarding it and using only
            // this.currentOpacity (the layer's opacity, now 1.0 by default
            // for copper) is what made zone translucency silently do
            // nothing on the WebGL backend specifically: Canvas2D's
            // ctx.fillStyle handles an rgba() string's alpha natively, so
            // this bug never showed up there, only on WebGL's own manual
            // color handling.
            const [r, g, b, colorAlpha] = parseColor(style.fillColor);
            const color = [r, g, b, colorAlpha * this.currentOpacity];
            // A single convex ring (rect/roundrect/oval/trapezoid pad outlines —
            // the overwhelming majority of real pad shapes; a rounded-rect SMD
            // footprint library alone typically outnumbers plain circular pads
            // several times over) never needs the stencil-buffer "stencil, then
            // cover" technique below, which exists for arbitrary (possibly
            // concave/self-intersecting/multi-ring-with-holes) shapes — a
            // straight fan triangulation from the ring's own first point is
            // exactly as correct for any convex polygon and, critically, merges
            // into the SAME single big batched buffer/draw call every other
            // plain triangle (including circular pads' own fans) already uses,
            // instead of costing a dedicated 2-draw-plus-~10-state-change GPU
            // job that (in the static-build case) gets replayed EVERY FRAME by
            // flush(), or (in the dynamic case) rebuilds its own throwaway
            // buffers every frame. On a real board with hundreds to thousands
            // of roundrect pads plus dozens of zone fill regions, skipping this
            // avoids the dominant cost of steady-state WebGL rendering — a real
            // board's trace showed the GPU process pegged at ~70k GPU
            // commands/sec (~1300/frame), almost entirely from replaying one
            // stencil job per non-circular pad/zone-fill-region every frame.
            if (usableRings.length === 1 && isConvexPolygon(usableRings[0])) {
                const ring = usableRings[0];
                for (let i = 1; i < ring.length - 1; i++) {
                    this.pushTriangle(ring[0], ring[i], ring[i + 1], color);
                }
            }
            else if (this.buildingStatic) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const ring of usableRings) {
                    for (const p of ring) {
                        minX = Math.min(minX, p.x);
                        minY = Math.min(minY, p.y);
                        maxX = Math.max(maxX, p.x);
                        maxY = Math.max(maxY, p.y);
                    }
                }
                // Close out whatever regular geometry came before this, so this
                // stencil job's position in staticCommands reflects its real
                // paint-order position instead of getting bucketed separately.
                this.flushPendingRegular();
                this.buildCommands.push({ kind: 'stencil', job: { rings: usableRings, color, minX, minY, maxX, maxY } });
                if (this.currentItemId !== null) {
                    this.currentItemStencilIndices.push(this.buildCommands.length - 1);
                }
            }
            else {
                // Outside a static build (grid/ratsnest/drag-preview/edit-
                // preview — anything drawn through beginDynamicFrame()), a
                // buildCommands entry is a dead letter: only endStaticBuild()
                // ever bakes buildCommands into staticCommands, and only
                // flush()'s STATIC branch ever replays staticCommands — the
                // dynamic/overlay draw path (uploadAndDrawDynamic/
                // flushOverlay) only ever looks at buildPositions/
                // buildColors. Any filled multiPolygon reached this way
                // (concave/multi-ring shapes only now — convex single-ring ones
                // take the fast path above) was, before that fast path existed,
                // why a dragged footprint's non-circular pads disappeared during
                // the live preview — see drawImmediateStencilFill's doc comment.
                // Still needed for genuinely concave/multi-ring cases (most zone
                // fills, custom pad shapes).
                this.drawImmediateStencilFill(usableRings, color);
            }
        }
        if (this.wantsStroke(style)) {
            for (const ring of usableRings) {
                this.pushStrokePolyline(ring, style.strokeColor, style.strokeWidth, true);
            }
        }
    }
    /**
     * Called every frame: uploads only the small dynamic (grid) buffer, then
     * draws it (behind everything — matches Canvas2D drawing the grid before
     * the board), followed by the already-uploaded static scene's commands
     * IN THEIR ORIGINAL PAINT ORDER (regular-geometry ranges and stencil
     * jobs interleaved — see staticCommands). No tessellation happens here —
     * that only happens inside a beginStaticBuild()/endStaticBuild() pair.
     */
    flush() {
        this.uploadAndDrawDynamic();
        for (const cmd of this.staticCommands) {
            if (cmd.kind === 'regular') {
                this.bindAndDraw(this.staticPositionBuffer, this.staticColorBuffer, cmd.start, cmd.count);
            }
            else if (cmd.kind === 'stencil') {
                this.drawCachedStencilJob(cmd.job);
            }
            else {
                this.drawCachedImageJob(cmd.job);
            }
        }
    }
    /** See Renderer.flushOverlay's doc comment — the second, overlay-only
     *  pass: just uploads+draws whatever was accumulated since the caller's
     *  own beginDynamicFrame(), with no static redraw after it. */
    flushOverlay() {
        this.uploadAndDrawDynamic();
    }
    uploadAndDrawDynamic() {
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.uniformMatrix3fv(this.matrixLocation, false, new Float32Array(this.viewMatrix.elements));
        gl.disable(gl.STENCIL_TEST);
        if (this.buildPositions.length > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicPositionBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.buildPositions), gl.DYNAMIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicColorBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.buildColors), gl.DYNAMIC_DRAW);
            this.bindAndDraw(this.dynamicPositionBuffer, this.dynamicColorBuffer, 0, this.buildPositions.length / 2);
        }
    }
    /** multiPolygon()'s dynamic-context fill path — see its call site's doc
     *  comment for why the normal buildCommands/staticCommands route
     *  (bake once, replay cheaply forever) doesn't apply here: dynamic
     *  content is rebuilt from scratch every single frame regardless, so
     *  there's no caching win to chase — just fan-into-stencil, cover, done,
     *  using throwaway buffers deleted the same tick. Flushes whatever
     *  regular triangles have already accumulated first (and resets the
     *  accumulator after), so this fill lands at its correct position in
     *  paint order instead of before or after everything else in the frame. */
    drawImmediateStencilFill(rings, color) {
        this.uploadAndDrawDynamic();
        this.buildPositions.length = 0;
        this.buildColors.length = 0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const fanPositions = [];
        for (const ring of rings) {
            const x0 = ring[0].x, y0 = ring[0].y;
            for (const p of ring) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
            for (let i = 1; i < ring.length - 1; i++) {
                fanPositions.push(x0, y0, ring[i].x, ring[i].y, ring[i + 1].x, ring[i + 1].y);
            }
        }
        const quad = [minX, minY, maxX, minY, maxX, maxY, minX, minY, maxX, maxY, minX, maxY];
        const gl = this.gl;
        const fanBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, fanBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fanPositions), gl.STREAM_DRAW);
        const quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quad), gl.STREAM_DRAW);
        this.drawCachedStencilJob({
            fanPositionBuffer: fanBuffer, fanVertexCount: fanPositions.length / 2,
            quadPositionBuffer: quadBuffer, color,
        });
        gl.deleteBuffer(fanBuffer);
        gl.deleteBuffer(quadBuffer);
    }
    bindAndDraw(positionBuffer, colorBuffer, first, vertexCount) {
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.uniformMatrix3fv(this.matrixLocation, false, new Float32Array(this.viewMatrix.elements));
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.enableVertexAttribArray(this.colorLocation);
        gl.vertexAttribPointer(this.colorLocation, 4, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, first, vertexCount);
    }
    /**
     * "Stencil, then cover", using buffers baked once in bakeStencilJob():
     * fan-triangulate each ring from its own first point and write into the
     * stencil buffer with an INVERT op — this computes the even-odd winding
     * parity at every pixel correctly regardless of the ring's actual shape
     * (concave, self-intersecting, whatever) or which point the fan starts
     * from, because any two fan triangulations of the same closed contour
     * differ only by area covered an EVEN number of times, which cancels
     * out under XOR/invert. This is the standard "stencil, then cover"
     * technique production vector-graphics renderers (nanovg and similar)
     * use for exactly this reason — not a glyph-specific hack, it's how you
     * fill an arbitrary path on a GPU without a full CPU polygon
     * triangulator (earcut, etc). No CPU work happens here — both buffers
     * were built once in bakeStencilJob(); this just binds and draws them.
     */
    drawCachedStencilJob(job) {
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.uniformMatrix3fv(this.matrixLocation, false, new Float32Array(this.viewMatrix.elements));
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.enable(gl.STENCIL_TEST);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
        gl.bindBuffer(gl.ARRAY_BUFFER, job.fanPositionBuffer);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.disableVertexAttribArray(this.colorLocation);
        gl.vertexAttrib4f(this.colorLocation, 0, 0, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, job.fanVertexCount);
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO); // self-clearing: reveal pass also resets stencil
        gl.bindBuffer(gl.ARRAY_BUFFER, job.quadPositionBuffer);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttrib4f(this.colorLocation, job.color[0], job.color[1], job.color[2], job.color[3] * this.currentOpacity);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.disable(gl.STENCIL_TEST);
    }
    drawCachedImageJob(job) {
        const gl = this.gl;
        gl.useProgram(this.imageProgram);
        gl.uniformMatrix3fv(this.imageMatrixLocation, false, new Float32Array(this.viewMatrix.elements));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, job.texture);
        gl.uniform1i(this.imageTextureLocation, 0);
        gl.uniform1f(this.imageOpacityLocation, job.opacity);
        gl.bindBuffer(gl.ARRAY_BUFFER, job.positionBuffer);
        gl.enableVertexAttribArray(this.imagePositionLocation);
        gl.vertexAttribPointer(this.imagePositionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, job.texCoordBuffer);
        gl.enableVertexAttribArray(this.imageTexCoordLocation);
        gl.vertexAttribPointer(this.imageTexCoordLocation, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    wantsStroke(style) {
        return !!style.strokeColor && !!style.strokeWidth && style.strokeWidth > 0;
    }
    pushVertex(x, y, color) {
        this.buildPositions.push(x, y);
        this.buildColors.push(color[0], color[1], color[2], color[3] * this.currentOpacity);
    }
    pushTriangle(a, b, c, color) {
        this.pushVertex(a.x, a.y, color);
        this.pushVertex(b.x, b.y, color);
        this.pushVertex(c.x, c.y, color);
    }
    // Main filled circles (pad bodies, via rings, drilled holes) — these are
    // the shapes people actually look at closely, so they get a real
    // circle's worth of segments, not the coarse count used for tiny stroke
    // joints below. (A previous version of this method delegated to
    // pushCircleFanColor(), which hardcodes the much coarser JOINT_SEGMENTS
    // — every filled circle on the board was rendering as a hexagon because
    // of that, not a rendering-quality tradeoff, a bug.)
    pushCircleFan(cx, cy, radius, colorStr) {
        const color = parseColor(colorStr);
        const center = new Vec2(cx, cy);
        const ring = circlePoints(center, radius, segmentsForRadius(radius, MIN_CIRCLE_SEGMENTS, MAX_CIRCLE_SEGMENTS));
        for (let i = 0; i < ring.length; i++) {
            const next = ring[(i + 1) % ring.length];
            this.pushTriangle(center, ring[i], next, color);
        }
    }
    /**
     * Expands a polyline into a stroke of the given width: one quad (two
     * triangles) per segment, a small round-JOIN fan at every interior
     * vertex, and a round CAP at each open end. Caps only need a half-disc
     * (the outward-facing half beyond the segment's own end edge) — the
     * inward half is already covered by the segment quad itself, so drawing
     * a full circle there doubles geometry for no visual difference. Joins
     * stay full small circles since which "outward" half to use there isn't
     * a fixed direction (depends on the turn angle between two segments).
     */
    pushStrokePolyline(points, colorStr, width, closed, capStyle = 'round') {
        const color = parseColor(colorStr);
        const halfWidth = width / 2;
        const segmentCount = closed ? points.length : points.length - 1;
        for (let i = 0; i < segmentCount; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = (-dy / len) * halfWidth, ny = (dx / len) * halfWidth;
            const a1 = new Vec2(a.x + nx, a.y + ny), a2 = new Vec2(a.x - nx, a.y - ny);
            const b1 = new Vec2(b.x + nx, b.y + ny), b2 = new Vec2(b.x - nx, b.y - ny);
            this.pushTriangle(a1, a2, b1, color);
            this.pushTriangle(a2, b2, b1, color);
        }
        if (halfWidth > 0) {
            const jointStart = closed ? 0 : 1;
            const jointEnd = closed ? points.length - 1 : points.length - 2;
            for (let i = 0; i <= jointEnd - jointStart; i++) {
                this.pushCircleFanColor(points[jointStart + i].x, points[jointStart + i].y, halfWidth, color);
            }
            // Butt caps just leave the segment quad's own flat end edge as
            // the boundary — the two triangles above already cover it, so
            // there's genuinely nothing more to draw here, not even a
            // degenerate case to guard against.
            if (!closed && capStyle === 'round') {
                const first = points[0], second = points[1];
                const startOutwardAngle = Math.atan2(first.y - second.y, first.x - second.x);
                this.pushSemicircleFanColor(first.x, first.y, halfWidth, startOutwardAngle, color);
                const last = points[points.length - 1], secondLast = points[points.length - 2];
                const endOutwardAngle = Math.atan2(last.y - secondLast.y, last.x - secondLast.x);
                this.pushSemicircleFanColor(last.x, last.y, halfWidth, endOutwardAngle, color);
            }
        }
    }
    /** Half-disc fan spanning [centerAngle - 90deg, centerAngle + 90deg] —
     * its flat diameter edge lines up exactly with the segment's own end
     * edge, so it reads as a seamless round cap despite only being a half
     * circle's worth of geometry. */
    pushSemicircleFanColor(cx, cy, radius, centerAngleRad, color) {
        const center = new Vec2(cx, cy);
        const startAngle = centerAngleRad - Math.PI / 2;
        const capSegments = jointSegmentsForRadius(radius) / 2;
        const points = [];
        for (let i = 0; i <= capSegments; i++) {
            const t = startAngle + (Math.PI * i) / capSegments;
            points.push(new Vec2(cx + radius * Math.cos(t), cy + radius * Math.sin(t)));
        }
        for (let i = 0; i < points.length - 1; i++) {
            this.pushTriangle(center, points[i], points[i + 1], color);
        }
    }
    pushCircleFanColor(cx, cy, radius, color) {
        const center = new Vec2(cx, cy);
        const ring = circlePoints(center, radius, jointSegmentsForRadius(radius));
        for (let i = 0; i < ring.length; i++) {
            const next = ring[(i + 1) % ring.length];
            this.pushTriangle(center, ring[i], next, color);
        }
    }
}
// Real circles people look at closely (pad/via/hole bodies) — up to a real
// circle's worth of segments (MAX_CIRCLE_SEGMENTS); MIN_CIRCLE_SEGMENTS is
// the floor for a drilled-hole-sized circle too small to need that many.
const MIN_CIRCLE_SEGMENTS = 8;
const MAX_CIRCLE_SEGMENTS = 24;
// Tiny fans at stroke joints/caps — coarser is fine since they're often
// just a couple pixels across (see segmentsForRadius). Both bounds must
// stay even so half of one (a cap) is still a whole number of segments
// spanning exactly 180 degrees.
const MIN_JOINT_SEGMENTS = 4;
const MAX_JOINT_SEGMENTS = 8;
/**
 * Static geometry is baked once at load time, independent of camera zoom
 * (see beginStaticBuild's own doc comment) — so segment count can't adapt
 * to "how zoomed-in is the user right now" the way some tools do. It CAN
 * adapt to the primitive's own world-space size, which is fixed and known
 * at bake time: a stroke joint on a 0.1mm-wide hatch line has a
 * 0.05mm radius — a couple of screen pixels even at extreme zoom — and
 * never needs anywhere near a real via/pad's segment count to look round.
 * Chooses the fewest segments (within [minSegments, maxSegments]) whose
 * worst-case deviation from a true circle (the "sagitta",
 * radius * (1 - cos(pi/n))) stays under MAX_SAGITTA_MM — small enough to
 * be imperceptible at any zoom a user would actually view a board at, but
 * loose enough that a real via/pad radius (~0.3-1mm+) still lands at or
 * near maxSegments, matching this file's previous fixed-24-segment look
 * for the shapes people actually zoom in on.
 */
const MAX_SAGITTA_MM = 0.008;
function segmentsForRadius(radius, minSegments, maxSegments) {
    if (radius <= 0) {
        return minSegments;
    }
    const ratio = MAX_SAGITTA_MM / radius;
    if (ratio >= 2) {
        // Sagitta budget exceeds the whole diameter — any segment count
        // clears it, so there's nothing to solve for; use the floor.
        return minSegments;
    }
    const n = Math.PI / Math.acos(1 - ratio);
    return Math.min(maxSegments, Math.max(minSegments, Math.ceil(n)));
}
/** Joint/cap segment count for a stroke of this radius (half-width),
 * rounded up to even so a cap fan (half of this) stays a whole number —
 * see MIN_JOINT_SEGMENTS/MAX_JOINT_SEGMENTS's own doc comment. */
function jointSegmentsForRadius(radius) {
    const n = segmentsForRadius(radius, MIN_JOINT_SEGMENTS, MAX_JOINT_SEGMENTS);
    return n % 2 === 0 ? n : n + 1;
}
/** Cross-product-sign-consistency check: true iff every consecutive vertex
 *  triple turns the same way (all-left or all-right), i.e. the ring is a
 *  simple convex polygon with no self-intersections. Collinear triples
 *  (zero cross product — e.g. two points along a straight pad edge) are
 *  skipped rather than treated as a turn, so a convex shape whose
 *  tessellation happens to include collinear points (most roundrect/oval/
 *  trapezoid pad outlines do) doesn't get misclassified as non-convex. Used
 *  by multiPolygon() to route convex single-ring fills through the cheap
 *  fan-triangulation path instead of the stencil-buffer technique the
 *  latter exists for arbitrary (possibly concave/self-intersecting) shapes
 *  — never actually needed for a shape this check accepts. */
function isConvexPolygon(ring) {
    if (ring.length < 3) {
        return false;
    }
    let sign = 0;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n], c = ring[(i + 2) % n];
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (Math.abs(cross) < 1e-9) {
            continue;
        }
        const s = cross > 0 ? 1 : -1;
        if (sign === 0) {
            sign = s;
        }
        else if (s !== sign) {
            return false;
        }
    }
    return sign !== 0;
}
function circlePoints(center, radius, segments) {
    const points = [];
    for (let i = 0; i < segments; i++) {
        const t = (i / segments) * Math.PI * 2;
        points.push(new Vec2(center.x + radius * Math.cos(t), center.y + radius * Math.sin(t)));
    }
    return points;
}
// The whole board only ever uses a handful of distinct color strings
// (one per layer, plus NPTH gray/highlight yellow/etc), but parseColor()
// gets called once per PRIMITIVE — thousands of times per static rebuild,
// and for the grid specifically, the exact same color string tens of
// thousands of times per dynamic frame. Regex-parsing the same string
// repeatedly is pure waste; cache by the string itself.
const colorCache = new Map();
/** Parses 'rgb(r,g,b)', 'rgba(r,g,b,a)', '#rgb', or '#rrggbb' into 0-1 floats. */
function parseColor(color) {
    const cached = colorCache.get(color);
    if (cached) {
        return cached;
    }
    const parsed = parseColorUncached(color);
    colorCache.set(color, parsed);
    return parsed;
}
function parseColorUncached(color) {
    if (color.startsWith('#')) {
        let hex = color.slice(1);
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        const r = parseInt(hex.slice(0, 2), 16) / 255;
        const g = parseInt(hex.slice(2, 4), 16) / 255;
        const b = parseInt(hex.slice(4, 6), 16) / 255;
        return [r, g, b, 1];
    }
    const match = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
    if (match) {
        return [
            parseFloat(match[1]) / 255,
            parseFloat(match[2]) / 255,
            parseFloat(match[3]) / 255,
            match[4] !== undefined ? parseFloat(match[4]) : 1,
        ];
    }
    return [1, 0, 1, 1]; // unmistakable magenta for an unparseable color, not a silent wrong guess
}
