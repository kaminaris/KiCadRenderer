import { Vec2 } from '../math/Vec2';
import { Matrix3 } from '../math/Matrix3';
import { Renderer, RenderStyle } from './Renderer';

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

export interface CachedStencilJob {
	fanPositionBuffer: WebGLBuffer;
	fanVertexCount: number;
	quadPositionBuffer: WebGLBuffer;
	color: [number, number, number, number];
}

export interface RawStencilJob {
	rings: Vec2[][];
	color: [number, number, number, number];
	minX: number; minY: number; maxX: number; maxY: number;
}

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
 *    the actual scene content changes: layer visibility/opacity, selection
 *    highlight, or a new board loaded.
 *  - DYNAMIC: small per-frame content that genuinely changes every frame
 *    (currently just the grid, which depends on the camera's current bbox).
 *    Cheap enough to fully re-tessellate every frame since it's a few
 *    hundred dots, not thousands of board items.
 *
 * Even-odd glyph fills (render_cache text) are part of the STATIC set too —
 * each gets its own small "stencil, then cover" pair of GPU buffers, built
 * once in endStaticBuild() and just bound-and-drawn (no CPU work) every
 * frame in draw().
 */
export class WebGLRenderer implements Renderer {
	protected gl: WebGLRenderingContext;
	protected program: WebGLProgram;
	protected matrixLocation: WebGLUniformLocation;
	protected positionLocation: number;
	protected colorLocation: number;

	protected staticPositionBuffer: WebGLBuffer;
	protected staticColorBuffer: WebGLBuffer;
	// Ordered so z-order between regular (fan/quad) geometry and stencil
	// (even-odd, e.g. zone fill) geometry is preserved. Drawing "all regular
	// geometry, then all stencil jobs" (an earlier version of this file did
	// exactly that) is WRONG whenever anything drawn later in paint order —
	// like a via, which sits on the always-on-top 'Vias' layer — is
	// supposed to sit on top of a zone fill: the zone would always win
	// regardless of true paint order, since every stencil job got shoved to
	// the end. Each command references a CONTIGUOUS vertex range of the one
	// uploaded static buffer (regular) or a baked stencil job (even-odd).
	protected staticCommands: ({ kind: 'regular'; start: number; count: number } | { kind: 'stencil'; job: CachedStencilJob })[] = [];

	protected dynamicPositionBuffer: WebGLBuffer;
	protected dynamicColorBuffer: WebGLBuffer;

	// Accumulation targets while a build is in progress — swapped between
	// the static and dynamic arrays depending on which build is active.
	protected buildPositions: number[] = [];
	protected buildColors: number[] = [];
	protected buildCommands: ({ kind: 'regular'; start: number; count: number } | { kind: 'stencil'; job: RawStencilJob })[] = [];
	protected pendingRegularStart = 0;
	protected buildingStatic = false;

	protected currentOpacity = 1;
	protected viewMatrix: Matrix3 = Matrix3.identity();

	constructor(canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl', { stencil: true, antialias: true });
		if (!gl) {
			throw new Error('WebGL is not available in this browser');
		}
		this.gl = gl;

		const vs = this.compileShader(gl.VERTEX_SHADER, vertexShaderSource);
		const fs = this.compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
		const program = gl.createProgram()!;
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			throw new Error(`WebGL program link failed: ${ gl.getProgramInfoLog(program) }`);
		}
		this.program = program;

		this.staticPositionBuffer = gl.createBuffer()!;
		this.staticColorBuffer = gl.createBuffer()!;
		this.dynamicPositionBuffer = gl.createBuffer()!;
		this.dynamicColorBuffer = gl.createBuffer()!;
		this.positionLocation = gl.getAttribLocation(program, 'aPosition');
		this.colorLocation = gl.getAttribLocation(program, 'aColor');
		this.matrixLocation = gl.getUniformLocation(program, 'uMatrix')!;

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	}

	protected compileShader(type: number, source: string): WebGLShader {
		const gl = this.gl;
		const shader = gl.createShader(type)!;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(shader);
			gl.deleteShader(shader);
			throw new Error(`WebGL shader compile failed: ${ log }`);
		}
		return shader;
	}

	setOpacity(opacity: number): void {
		this.currentOpacity = opacity;
	}

	setViewMatrix(matrix: Matrix3): void {
		this.viewMatrix = matrix;
	}

	clear(color: string): void {
		const [r, g, b] = parseColor(color);
		const gl = this.gl;
		gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
		gl.clearColor(r, g, b, 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
	}

	/** Start accumulating the board scene into the STATIC (upload-once) buffer. */
	beginStaticBuild(): void {
		this.buildingStatic = true;
		this.buildPositions.length = 0;
		this.buildColors.length = 0;
		this.buildCommands.length = 0;
		this.pendingRegularStart = 0;
	}

	/** Closes out whatever regular-geometry range has accumulated since the
	 * last command, right before a stencil job needs to be interleaved (or
	 * at the very end of the build) — see the staticCommands field comment. */
	protected flushPendingRegular(): void {
		const end = this.buildPositions.length / 2;
		const count = end - this.pendingRegularStart;
		if (count > 0) {
			this.buildCommands.push({ kind: 'regular', start: this.pendingRegularStart, count });
		}
		this.pendingRegularStart = end;
	}

	/** Uploads everything accumulated since beginStaticBuild() to persistent GPU buffers. */
	endStaticBuild(): void {
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
		}
		this.staticCommands = this.buildCommands.map(cmd =>
			cmd.kind === 'stencil' ? { kind: 'stencil', job: this.bakeStencilJob(cmd.job) } : cmd);

		this.buildingStatic = false;
		this.buildPositions.length = 0;
		this.buildColors.length = 0;
		this.buildCommands.length = 0;
	}

	protected bakeStencilJob(job: RawStencilJob): CachedStencilJob {
		const gl = this.gl;
		const fanPositions: number[] = [];
		for (const ring of job.rings) {
			const x0 = ring[0]!.x, y0 = ring[0]!.y;
			for (let i = 1; i < ring.length - 1; i++) {
				fanPositions.push(x0, y0, ring[i]!.x, ring[i]!.y, ring[i + 1]!.x, ring[i + 1]!.y);
			}
		}
		const fanPositionBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, fanPositionBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fanPositions), gl.STATIC_DRAW);

		const quad = [
			job.minX, job.minY, job.maxX, job.minY, job.maxX, job.maxY,
			job.minX, job.minY, job.maxX, job.maxY, job.minX, job.maxY,
		];
		const quadPositionBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, quadPositionBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quad), gl.STATIC_DRAW);

		return { fanPositionBuffer, fanVertexCount: fanPositions.length / 2, quadPositionBuffer, color: job.color };
	}

	/** Start accumulating per-frame content (the grid) into the DYNAMIC buffer. */
	beginDynamicFrame(): void {
		this.buildingStatic = false;
		this.buildPositions.length = 0;
		this.buildColors.length = 0;
	}

	// Layer boundaries inside a build only matter for opacity (baked into
	// each vertex's own alpha, see pushVertex) — nothing else to do here.
	beginBatch(): void {}
	endBatch(): void {}

	line(points: Vec2[], style: RenderStyle): void {
		if (points.length < 2 || !this.wantsStroke(style)) {
			return;
		}
		this.pushStrokePolyline(points, style.strokeColor!, style.strokeWidth!, false);
	}

	polygon(points: Vec2[], style: RenderStyle): void {
		if (points.length < 3) {
			return;
		}
		if (style.fillColor) {
			this.pushConvexFan(points, style.fillColor);
		}
		if (this.wantsStroke(style)) {
			this.pushStrokePolyline(points, style.strokeColor!, style.strokeWidth!, true);
		}
	}

	circle(center: Vec2, radius: number, style: RenderStyle): void {
		if (style.fillColor) {
			this.pushCircleFan(center.x, center.y, radius, style.fillColor);
		}
		if (this.wantsStroke(style)) {
			const ring = circlePoints(center, radius, circleSegments);
			this.pushStrokePolyline(ring, style.strokeColor!, style.strokeWidth!, true);
		}
	}

	arc(center: Vec2, radius: number, startAngleRad: number, endAngleRad: number, style: RenderStyle): void {
		if (!this.wantsStroke(style)) {
			return;
		}
		const points: Vec2[] = [];
		const steps = Math.max(4, Math.ceil((Math.abs(endAngleRad - startAngleRad) / (Math.PI * 2)) * circleSegments));
		for (let i = 0; i <= steps; i++) {
			const t = startAngleRad + ((endAngleRad - startAngleRad) * i) / steps;
			points.push(new Vec2(center.x + radius * Math.cos(t), center.y + radius * Math.sin(t)));
		}
		this.pushStrokePolyline(points, style.strokeColor!, style.strokeWidth!, false);
	}

	rect(topLeft: Vec2, width: number, height: number, style: RenderStyle): void {
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
			this.pushStrokePolyline(corners, style.strokeColor!, style.strokeWidth!, true);
		}
	}

	multiPolygon(rings: Vec2[][], style: RenderStyle): void {
		const usableRings = rings.filter(r => r.length >= 3);
		if (usableRings.length === 0) {
			return;
		}
		if (style.fillColor) {
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const ring of usableRings) {
				for (const p of ring) {
					minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
					maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
				}
			}
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
			// Close out whatever regular geometry came before this, so this
			// stencil job's position in staticCommands reflects its real
			// paint-order position instead of getting bucketed separately.
			this.flushPendingRegular();
			this.buildCommands.push({ kind: 'stencil', job: { rings: usableRings, color: [r, g, b, colorAlpha * this.currentOpacity], minX, minY, maxX, maxY } });
		}
		if (this.wantsStroke(style)) {
			for (const ring of usableRings) {
				this.pushStrokePolyline(ring, style.strokeColor!, style.strokeWidth!, true);
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
	flush(): void {
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

		for (const cmd of this.staticCommands) {
			if (cmd.kind === 'regular') {
				this.bindAndDraw(this.staticPositionBuffer, this.staticColorBuffer, cmd.start, cmd.count);
			}
			else {
				this.drawCachedStencilJob(cmd.job);
			}
		}
	}

	protected bindAndDraw(positionBuffer: WebGLBuffer, colorBuffer: WebGLBuffer, first: number, vertexCount: number): void {
		const gl = this.gl;
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
	protected drawCachedStencilJob(job: CachedStencilJob): void {
		const gl = this.gl;
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

	protected wantsStroke(style: RenderStyle): boolean {
		return !!style.strokeColor && !!style.strokeWidth && style.strokeWidth > 0;
	}

	protected pushVertex(x: number, y: number, color: [number, number, number, number]): void {
		this.buildPositions.push(x, y);
		this.buildColors.push(color[0], color[1], color[2], color[3] * this.currentOpacity);
	}

	protected pushTriangle(a: Vec2, b: Vec2, c: Vec2, color: [number, number, number, number]): void {
		this.pushVertex(a.x, a.y, color);
		this.pushVertex(b.x, b.y, color);
		this.pushVertex(c.x, c.y, color);
	}

	protected pushConvexFan(points: Vec2[], colorStr: string): void {
		const color = parseColor(colorStr);
		const origin = points[0]!;
		for (let i = 1; i < points.length - 1; i++) {
			this.pushTriangle(origin, points[i]!, points[i + 1]!, color);
		}
	}

	// Main filled circles (pad bodies, via rings, drilled holes) — these are
	// the shapes people actually look at closely, so they get a real
	// circle's worth of segments, not the coarse count used for tiny stroke
	// joints below. (A previous version of this method delegated to
	// pushCircleFanColor(), which hardcodes the much coarser JOINT_SEGMENTS
	// — every filled circle on the board was rendering as a hexagon because
	// of that, not a rendering-quality tradeoff, a bug.)
	protected pushCircleFan(cx: number, cy: number, radius: number, colorStr: string): void {
		const color = parseColor(colorStr);
		const center = new Vec2(cx, cy);
		const ring = circlePoints(center, radius, circleSegments);
		for (let i = 0; i < ring.length; i++) {
			const next = ring[(i + 1) % ring.length]!;
			this.pushTriangle(center, ring[i]!, next, color);
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
	protected pushStrokePolyline(points: Vec2[], colorStr: string, width: number, closed: boolean): void {
		const color = parseColor(colorStr);
		const halfWidth = width / 2;
		const segmentCount = closed ? points.length : points.length - 1;

		for (let i = 0; i < segmentCount; i++) {
			const a = points[i]!;
			const b = points[(i + 1) % points.length]!;
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
				this.pushCircleFanColor(points[jointStart + i]!.x, points[jointStart + i]!.y, halfWidth, color);
			}
			if (!closed) {
				const first = points[0]!, second = points[1]!;
				const startOutwardAngle = Math.atan2(first.y - second.y, first.x - second.x);
				this.pushSemicircleFanColor(first.x, first.y, halfWidth, startOutwardAngle, color);

				const last = points[points.length - 1]!, secondLast = points[points.length - 2]!;
				const endOutwardAngle = Math.atan2(last.y - secondLast.y, last.x - secondLast.x);
				this.pushSemicircleFanColor(last.x, last.y, halfWidth, endOutwardAngle, color);
			}
		}
	}

	/** Half-disc fan spanning [centerAngle - 90deg, centerAngle + 90deg] —
	 * its flat diameter edge lines up exactly with the segment's own end
	 * edge, so it reads as a seamless round cap despite only being a half
	 * circle's worth of geometry. */
	protected pushSemicircleFanColor(cx: number, cy: number, radius: number, centerAngleRad: number, color: [number, number, number, number]): void {
		const center = new Vec2(cx, cy);
		const startAngle = centerAngleRad - Math.PI / 2;
		const points: Vec2[] = [];
		for (let i = 0; i <= capSegments; i++) {
			const t = startAngle + (Math.PI * i) / capSegments;
			points.push(new Vec2(cx + radius * Math.cos(t), cy + radius * Math.sin(t)));
		}
		for (let i = 0; i < points.length - 1; i++) {
			this.pushTriangle(center, points[i]!, points[i + 1]!, color);
		}
	}

	protected pushCircleFanColor(cx: number, cy: number, radius: number, color: [number, number, number, number]): void {
		const center = new Vec2(cx, cy);
		const ring = circlePoints(center, radius, jointSegments);
		for (let i = 0; i < ring.length; i++) {
			const next = ring[(i + 1) % ring.length]!;
			this.pushTriangle(center, ring[i]!, next, color);
		}
	}
}

// Real circles people look at closely (pad/via/hole bodies).
const circleSegments = 24;
// Tiny fans at stroke joints/caps — coarser is fine since they're a couple
// pixels across, but needs to be even so CAP_SEGMENTS (half of it) stays a
// whole number of segments spanning exactly 180 degrees.
const jointSegments = 8;
const capSegments = jointSegments / 2;

function circlePoints(center: Vec2, radius: number, segments: number): Vec2[] {
	const points: Vec2[] = [];
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
const colorCache = new Map<string, [number, number, number, number]>();

/** Parses 'rgb(r,g,b)', 'rgba(r,g,b,a)', '#rgb', or '#rrggbb' into 0-1 floats. */
function parseColor(color: string): [number, number, number, number] {
	const cached = colorCache.get(color);
	if (cached) {
		return cached;
	}
	const parsed = parseColorUncached(color);
	colorCache.set(color, parsed);
	return parsed;
}

function parseColorUncached(color: string): [number, number, number, number] {
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
			parseFloat(match[1]!) / 255,
			parseFloat(match[2]!) / 255,
			parseFloat(match[3]!) / 255,
			match[4] !== undefined ? parseFloat(match[4]!) : 1,
		];
	}
	return [1, 0, 1, 1]; // unmistakable magenta for an unparseable color, not a silent wrong guess
}
