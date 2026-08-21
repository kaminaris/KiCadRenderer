/*
    Ported from kicanvas (https://github.com/theacodes/kicanvas), MIT License.
    Copyright (c) 2022 Alethea Katherine Flowers.
    Full text available at: https://opensource.org/licenses/MIT
*/
import { Vec2 } from './Vec2';
/**
 * An axis-alignment bounding box (AABB)
 */
export class BBox {
    x;
    y;
    w;
    h;
    context;
    /**
     * Create a bounding box
     */
    constructor(x = 0, y = 0, w = 0, h = 0, context) {
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.context = context;
        if (this.w < 0) {
            this.w *= -1;
            this.x -= this.w;
        }
        if (this.h < 0) {
            this.h *= -1;
            this.y -= this.h;
        }
    }
    copy() {
        return new BBox(this.x, this.y, this.w, this.h, this.context);
    }
    /**
     * Create a BBox given the top left and bottom right corners
     */
    static fromCorners(x1, y1, x2, y2, context) {
        if (x2 < x1) {
            [x1, x2] = [x2, x1];
        }
        if (y2 < y1) {
            [y1, y2] = [y2, y1];
        }
        return new BBox(x1, y1, x2 - x1, y2 - y1, context);
    }
    /**
     * Create a BBox that contains all the given points
     */
    static fromPoints(points, context) {
        if (points.length == 0) {
            return new BBox(0, 0, 0, 0);
        }
        const firstPt = points[0];
        const start = firstPt.copy();
        const end = firstPt.copy();
        for (const p of points) {
            start.x = Math.min(start.x, p.x);
            start.y = Math.min(start.y, p.y);
            end.x = Math.max(end.x, p.x);
            end.y = Math.max(end.y, p.y);
        }
        return BBox.fromCorners(start.x, start.y, end.x, end.y, context);
    }
    /**
     * Combine two or more BBoxes into a new BBox that contains both
     */
    static combine(boxes, context) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const box of boxes) {
            if (!box.valid) {
                continue;
            }
            minX = Math.min(minX, box.x);
            minY = Math.min(minY, box.y);
            maxX = Math.max(maxX, box.x2);
            maxY = Math.max(maxY, box.y2);
        }
        if (minX == Number.POSITIVE_INFINITY ||
            minY == Number.POSITIVE_INFINITY ||
            maxX == Number.NEGATIVE_INFINITY ||
            maxY == Number.NEGATIVE_INFINITY) {
            return new BBox(0, 0, 0, 0, context);
        }
        return BBox.fromCorners(minX, minY, maxX, maxY, context);
    }
    /**
     * @returns true if the bbox has a non-zero area
     */
    get valid() {
        return ((this.w !== 0 || this.h !== 0) &&
            this.w !== undefined &&
            this.h !== undefined);
    }
    get start() {
        return new Vec2(this.x, this.y);
    }
    set start(v) {
        this.x = v.x;
        this.y = v.y;
    }
    get end() {
        return new Vec2(this.x + this.w, this.y + this.h);
    }
    set end(v) {
        this.x2 = v.x;
        this.y2 = v.y;
    }
    get topLeft() {
        return this.start;
    }
    get topRight() {
        return new Vec2(this.x + this.w, this.y);
    }
    get bottomLeft() {
        return new Vec2(this.x, this.y + this.h);
    }
    get bottomRight() {
        return this.end;
    }
    get x2() {
        return this.x + this.w;
    }
    set x2(v) {
        this.w = v - this.x;
        if (this.w < 0) {
            this.w *= -1;
            this.x -= this.w;
        }
    }
    get y2() {
        return this.y + this.h;
    }
    set y2(v) {
        this.h = v - this.y;
        if (this.h < 0) {
            this.h *= -1;
            this.y -= this.h;
        }
    }
    get center() {
        return new Vec2(this.x + this.w / 2, this.y + this.h / 2);
    }
    /**
     * @returns A new BBox transformed by the given matrix.
     */
    transform(mat) {
        const start = mat.transform(this.start);
        const end = mat.transform(this.end);
        return BBox.fromCorners(start.x, start.y, end.x, end.y, this.context);
    }
    /**
     * @returns A new BBox with the size uniformly modified from the center
     */
    grow(dx, dy) {
        dy ??= dx;
        return new BBox(this.x - dx, this.y - dy, this.w + dx * 2, this.h + dy * 2, this.context);
    }
    scale(s) {
        return BBox.fromPoints([this.start.multiply(s), this.end.multiply(s)], this.context);
    }
    /**
     * @returns a BBox flipped around the X axis (mirrored Y)
     */
    mirrorVertical() {
        return new BBox(this.x, -this.y, this.w, -this.h);
    }
    /** returns true if this box contains the other */
    contains(other) {
        return (this.containsPoint(other.start) && this.containsPoint(other.end));
    }
    /**
     * @returns true if the point is within the bounding box.
     */
    containsPoint(v) {
        return (v.x >= this.x && v.x <= this.x2 && v.y >= this.y && v.y <= this.y2);
    }
    /**
     * @returns A new Vec2 constrained within this bounding box
     */
    constrainPoint(v) {
        const x = Math.min(Math.max(v.x, this.x), this.x2);
        const y = Math.min(Math.max(v.y, this.y), this.y2);
        return new Vec2(x, y);
    }
    intersectSegment(a, b) {
        if (this.containsPoint(a)) {
            return null;
        }
        const left = [this.topLeft, this.bottomLeft];
        const right = [this.topRight, this.bottomRight];
        const top = [this.topLeft, this.topRight];
        const bottom = [this.bottomLeft, this.bottomRight];
        const start = a;
        const end = b;
        for (const seg of [left, right, top, bottom]) {
            const intersection = Vec2.segmentIntersect(a, b, ...seg);
            if (!intersection) {
                continue;
            }
            if (intersection.sub(start).squaredMagnitude <
                end.sub(start).squaredMagnitude) {
                end.set(intersection);
            }
        }
        if (start.equals(end)) {
            return null;
        }
        return end;
    }
}
