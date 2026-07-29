/*
	Ported from kicanvas (https://github.com/theacodes/kicanvas), MIT License.
	Copyright (c) 2022 Alethea Katherine Flowers.
	Full text available at: https://opensource.org/licenses/MIT
*/

import { Vec2 } from './Vec2';

export type AngleLike = Angle | number;

/**
 * An angle for rotation and orientation
 */
export class Angle {
	// Use TS `protected` (not native `#field`) and default-initialize —
	// the constructor only assigns these indirectly through the `radians`
	// setter, which strictPropertyInitialization can't see through.
	// Consumers with `importHelpers` (e.g. Angular) also need tslib for
	// native private fields, which fails for sources outside a package's
	// node_modules tree.
	protected thetaRad = 0;
	protected thetaDeg = 0;

	/**
	 * Convert radians to degrees
	 */
	static radToDeg(radians: number) {
		return (radians / Math.PI) * 180;
	}

	/**
	 * Convert degrees to radians
	 */
	static degToRad(degrees: number) {
		return (degrees / 180) * Math.PI;
	}

	/** Round degrees to two decimal places
	 *
	 * A lot of math involving angles is done with degrees to two decimal places
	 * instead of radians to match KiCAD's behavior and to avoid floating point
	 * nonsense.
	 */
	static round(degrees: number): number {
		return Math.round((degrees + Number.EPSILON) * 100) / 100;
	}

	/**
	 * Create an Angle
	 */
	constructor(radians: AngleLike) {
		if (radians instanceof Angle) {
			return radians;
		}
		this.radians = radians;
	}

	copy() {
		return new Angle(this.radians);
	}

	get radians() {
		return this.thetaRad;
	}

	set radians(v) {
		this.thetaRad = v;
		this.thetaDeg = Angle.round(Angle.radToDeg(v));
	}

	get degrees() {
		return this.thetaDeg;
	}

	set degrees(v) {
		this.thetaDeg = v;
		this.thetaRad = Angle.degToRad(v);
	}

	static fromDegrees(v: number) {
		return new Angle(Angle.degToRad(v));
	}

	/**
	 * Returns a new Angle representing the sum of this angle and the given angle.
	 */
	add(other: AngleLike) {
		const sum = this.radians + new Angle(other).radians;
		return new Angle(sum);
	}

	/**
	 * Returns a new Angle representing the different of this angle and the given angle.
	 */
	sub(other: AngleLike) {
		const diff = this.radians - new Angle(other).radians;
		return new Angle(diff);
	}

	/**
	 * @returns a new Angle constrained to 0 to 360 degrees.
	 */
	normalize() {
		let deg = Angle.round(this.degrees);

		while (deg < 0) {
			deg += 360;
		}
		while (deg >= 360) {
			deg -= 360;
		}

		return Angle.fromDegrees(deg);
	}

	/**
	 * @returns a new Angle constrained to -180 to 180 degrees.
	 */
	normalize180() {
		let deg = Angle.round(this.degrees);

		while (deg <= -180) {
			deg += 360;
		}
		while (deg > 180) {
			deg -= 360;
		}

		return Angle.fromDegrees(deg);
	}

	/**
	 * @returns a new Angle constrained to -360 to +360 degrees.
	 */
	normalize720() {
		let deg = Angle.round(this.degrees);

		while (deg < -360) {
			deg += 360;
		}
		while (deg >= 360) {
			deg -= 360;
		}

		return Angle.fromDegrees(deg);
	}

	/**
	 * @returns a new Angle that's reflected in the other direction, for
	 * example, 90 degrees ends up being -90 or 270 degrees (when normalized).
	 */
	negative(): Angle {
		return new Angle(-this.radians);
	}

	get isVertical() {
		return this.degrees == 90 || this.degrees == 270;
	}

	get isHorizontal() {
		return this.degrees == 0 || this.degrees == 180;
	}

	rotatePoint(point: Vec2, origin: Vec2 = new Vec2(0, 0)): Vec2 {
		let x = point.x - origin.x;
		let y = point.y - origin.y;

		const angle = this.normalize();

		// shortcuts for 0, 90, 180, and 270
		if (angle.degrees == 0) {
			// do nothing
		}
		else if (angle.degrees == 90) {
			[x, y] = [y, -x];
		}
		else if (angle.degrees == 180) {
			[x, y] = [-x, -y];
		}
		else if (angle.degrees == 270) {
			[x, y] = [-y, x];
		}
		// no shortcut, do the actual math.
		else {
			const sina = Math.sin(angle.radians);
			const cosa = Math.cos(angle.radians);
			const [x0, y0] = [x, y];

			x = y0 * sina + x0 * cosa;
			y = y0 * cosa - x0 * sina;
		}

		x += origin.x;
		y += origin.y;

		return new Vec2(x, y);
	}
}
