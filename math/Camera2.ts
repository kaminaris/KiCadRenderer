/*
	Ported from kicanvas (https://github.com/theacodes/kicanvas), MIT License.
	Copyright (c) 2022 Alethea Katherine Flowers.
	Full text available at: https://opensource.org/licenses/MIT
*/

import { Vec2 }               from './Vec2';
import { Matrix3 }            from './Matrix3';
import { Angle, type AngleLike } from './Angle';
import { BBox }                from './BBox';

/**
 * A camera in 2d space.
 *
 * This manages the minimal state required to pan, zoom, and rotate. It's
 * abstract and isn't integrated into any specific graphics backend. Use
 * .matrix to get the complete transformation matrix to pass to whichever
 * graphics backend you're using.
 */
export class Camera2 {
	/**
	 * Create a camera
	 * @param viewport_size - The width and height of the viewport
	 * @param center - The point at which the camera's view is centered
	 * @param zoom - Scale factor, increasing numbers zoom the camera in.
	 * @param rotation - Rotation (roll) in radians.
	 */
	constructor(
		public viewportSize: Vec2 = new Vec2(0, 0),
		public center: Vec2 = new Vec2(0, 0),
		public zoom: number = 1,
		public rotation: Angle = new Angle(0)
	) {}

	/**
	 * Relative translation
	 */
	translate(v: Vec2) {
		this.center.x += v.x;
		this.center.y += v.y;
	}

	/**
	 * Relative rotation
	 */
	rotate(a: AngleLike) {
		this.rotation = this.rotation.add(a);
	}

	/**
	 * Complete transformation matrix.
	 */
	get matrix(): Matrix3 {
		const mx = this.viewportSize.x / 2;
		const my = this.viewportSize.y / 2;
		const dx = this.center.x - this.center.x * this.zoom;
		const dy = this.center.y - this.center.y * this.zoom;
		const left = -(this.center.x - mx) + dx;
		const top = -(this.center.y - my) + dy;
		return Matrix3.translation(left, top)
			.rotateSelf(this.rotation)
			.scaleSelf(this.zoom, this.zoom);
	}

	/**
	 * Bounding box representing the camera's view
	 * */
	get bbox(): BBox {
		const m = this.matrix.inverse();
		const start = m.transform(new Vec2(0, 0));
		const end = m.transform(
			new Vec2(this.viewportSize.x, this.viewportSize.y)
		);
		return new BBox(start.x, start.y, end.x - start.x, end.y - start.y);
	}

	/**
	 * Move the camera and adjust zoom so that the given bounding box is in
	 * view.
	 */
	set bbox(bbox: BBox) {
		const zoomW = this.viewportSize.x / bbox.w;
		const zoomH = this.viewportSize.y / bbox.h;
		const centerX = bbox.x + bbox.w / 2;
		const centerY = bbox.y + bbox.h / 2;
		this.zoom = Math.min(zoomW, zoomH);
		this.center.set(centerX, centerY);
	}

	get top() {
		return this.bbox.y;
	}

	get bottom() {
		return this.bbox.y2;
	}

	get left() {
		return this.bbox.x;
	}

	get right() {
		return this.bbox.x2;
	}

	/**
	 * Apply this camera to a 2d canvas
	 *
	 * A simple convenience method that sets the canvas's transform to
	 * the camera's transformation matrix.
	 */
	applyToCanvas(ctx: CanvasRenderingContext2D) {
		this.viewportSize.set(ctx.canvas.clientWidth, ctx.canvas.clientHeight);
		const m = Matrix3.fromDOMMatrix(ctx.getTransform());
		m.multiplySelf(this.matrix);
		ctx.setTransform(m.toDOMMatrix());
	}

	/**
	 * Transform screen coordinates to world coordinates
	 */
	screenToWorld(v: Vec2): Vec2 {
		return this.matrix.inverse().transform(v);
	}

	/**
	 * Transform world coordinates to screen coordinates
	 */
	worldToScreen(v: Vec2): Vec2 {
		return this.matrix.transform(v);
	}
}
