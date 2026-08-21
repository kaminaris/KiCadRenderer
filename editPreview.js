import { Vec2 } from './math/Vec2';
import { computeStrokeTextGeometry, drawStrokeTextGeometry } from './paint/TextPaint';
export function drawCrosshair(renderer, at, color, size = 0.5) {
    renderer.line([new Vec2(at.x - size, at.y), new Vec2(at.x + size, at.y)], { strokeColor: color, strokeWidth: 0.1 });
    renderer.line([new Vec2(at.x, at.y - size), new Vec2(at.x, at.y + size)], { strokeColor: color, strokeWidth: 0.1 });
}
export function rotatePreviewPoint(p, rotationDeg) {
    const rad = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return new Vec2(p.x * cos + p.y * sin, -p.x * sin + p.y * cos);
}
/**
 * Live preview for the global/hier label tools — flag/arrow outline (exact
 * same point arrays SchematicPainter's buildGlobalLabel/buildHierLabelShape
 * use for the committed render, since those are simple fixed-size polygons)
 * plus the typed text at a fixed, un-tuned offset. Deliberately NOT byte-
 * identical to the committed text placement (which uses an empirically-tuned
 * offset formula documented in SchematicPainter.ts) — a preview only needs
 * to convey shape/direction before commit, not pixel-perfect final position.
 */
export function drawLabelFlagPreview(renderer, kind, worldOrigin, text, shape, rotation, color) {
    const textSize = 0.7;
    const s = 1.0;
    let pts = [];
    let shapeRotation = rotation;
    if (kind === 'flag') {
        // flipped shapes
        if (shape === 'output') {
            pts = [
                { x: 0, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 }, { x: 0, y: -s / 2 }, { x: 0, y: s / 2 }
            ];
        }
        else if (shape === 'input') {
            pts = [
                { x: s, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: 0, y: 0 }, { x: s / 2, y: -s / 2 }, { x: s, y: -s / 2 }, { x: s, y: s / 2 }
            ];
        }
        else if (shape === 'bidirectional' || shape === 'tri_state') {
            pts = [
                { x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 }, { x: 0, y: 0 }, { x: s / 2, y: s / 2 }
            ];
        }
        else {
            pts = [
                { x: 0, y: s / 2 }, { x: s, y: s / 2 }, { x: s, y: -s / 2 }, { x: 0, y: -s / 2 }, { x: 0, y: s / 2 }
            ];
        }
        shapeRotation = rotation + 180;
    }
    else {
        switch (shape) {
            case 'output':
                pts = [
                    { x: 0, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 },
                    { x: 0, y: -s / 2 }, { x: 0, y: s / 2 }
                ];
                break;
            case 'input':
                pts = [
                    { x: s, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: 0, y: 0 }, { x: s / 2, y: -s / 2 },
                    { x: s, y: -s / 2 }, { x: s, y: s / 2 }
                ];
                break;
            case 'bidirectional':
            case 'tri_state':
                pts = [
                    { x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 }, { x: 0, y: 0 },
                    { x: s / 2, y: s / 2 }
                ];
                break;
            default:
                pts = [
                    { x: 0, y: s / 2 }, { x: s, y: s / 2 }, { x: s, y: -s / 2 }, { x: 0, y: -s / 2 }, { x: 0, y: s / 2 }
                ];
                break;
        }
    }
    const worldPts = pts.map((p) => {
        const rotated = rotatePreviewPoint(p, shapeRotation);
        return new Vec2(rotated.x + worldOrigin.x, rotated.y + worldOrigin.y);
    });
    renderer.line(worldPts, { strokeColor: color, strokeWidth: 0.15 });
    const dist = s * 2.5;
    let textOffset;
    switch (rotation) {
        case 90:
            textOffset = new Vec2(0, -dist);
            break;
        case 180:
            textOffset = new Vec2(-dist, 0);
            break;
        case 270:
            textOffset = new Vec2(0, dist);
            break;
        default:
            textOffset = new Vec2(dist, 0);
            break;
    }
    const worldTextPos = new Vec2(worldOrigin.x + textOffset.x, worldOrigin.y + textOffset.y);
    const textAngle = (rotation === 90 || rotation === 270) ? 90 : 0;
    const hAlign = rotation === 180 ? 1 : 0;
    const geometry = computeStrokeTextGeometry(text, worldTextPos, textSize, textAngle, false, 0.15, { x: hAlign, y: 0.5 });
    drawStrokeTextGeometry(renderer, geometry, color);
}
