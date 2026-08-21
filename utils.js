import { Vec2 } from './math/Vec2';
// Utility helpers extracted from KicadRenderSession.ts
// ---- Auto-junction geometry (junctionNeededAt) ----
/** 0.001mm — matches the precision real schematic coordinates actually
 *  carry; generous enough to absorb float noise, tight enough to never
 *  merge two genuinely distinct points. */
export const JUNCTION_POINT_EPS = 1e-3;
/** Pins/labels contribute a "this is a distinct thing" exit angle that has
 *  no real geometric direction — offset far outside any real angle's range
 *  ([0, 2π)) so it can never collide with (and get de-duped against) an
 *  actual wire direction, mirroring real KiCad's own uniqueAngle counter. */
export const SYNTHETIC_ANGLE_BASE = 1000;
/** Read the board's named origin (grid_origin or aux_axis_origin) from a
 *  board setup AST node. Returns a zero Vec2 when values are missing or
 *  non-finite to avoid propagating NaNs. Kept with the function during the
 *  move so callers retain the original intent and documentation. */
export function readBoardOrigin(setup, name) {
    const origin = setup?.findFirstChildByName?.(name);
    const x = Number(origin?.attributes?.[0]?.value);
    const y = Number(origin?.attributes?.[1]?.value);
    return Number.isFinite(x) && Number.isFinite(y) ? new Vec2(x, y) : new Vec2(0, 0);
}
export function sexprParenDelta(line) {
    let delta = 0;
    let inQuote = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (char === '"' && (index === 0 || line[index - 1] !== '\\')) {
            inQuote = !inQuote;
        }
        else if (!inQuote && char === '(') {
            delta++;
        }
        else if (!inQuote && char === ')') {
            delta--;
        }
    }
    return delta;
}
/** Migrates the broken outline syntax emitted by early zone-tool builds
 * before the permissive app parser sees it. In `(( pts ...))`, the second
 * opening parenthesis is misread as an element name, which made the next
 * closing parenthesis prematurely end the zone and left its settings at the
 * board root. The migration restores `(polygon (pts ...))` and the missing
 * zone closing parenthesis before the next board-level item. */
export function repairLegacyMalformedZoneText(text) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const zoneChildren = new Set([
        'net', 'net_name', 'layer', 'layers', 'property', 'tstamp', 'uuid', 'hatch', 'priority',
        'connect_pads', 'min_thickness', 'filled_areas_thickness', 'fill', 'placement', 'keepout',
        'polygon', 'filled_polygon', 'fill_segments', 'attr', 'locked', 'name'
    ]);
    const result = [];
    let repairing = false;
    let zoneIndent = '\t';
    let sawPolygon = false;
    let zoneDepth = 0;
    let changed = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const nextLine = lines[index + 1] ?? '';
        const lineDepthDelta = sexprParenDelta(line);
        const zoneStart = line.match(/^(\s*)\(zone\s*$/);
        if (zoneStart && !repairing) {
            zoneIndent = zoneStart[1];
            sawPolygon = false;
            zoneDepth = lineDepthDelta;
        }
        const malformed = line.match(/^(\s*)\(\(\s+pts\s*$/);
        if (malformed) {
            const polygonIndent = malformed[1];
            zoneIndent = polygonIndent.endsWith('\t') ? polygonIndent.slice(0, -1) : polygonIndent;
            result.push(`${polygonIndent}(polygon`, `${polygonIndent}\t(pts`);
            repairing = true;
            sawPolygon = true;
            zoneDepth += lineDepthDelta;
            changed = true;
            continue;
        }
        if (/^\s*\(polygon\s*$/.test(line)) {
            sawPolygon = true;
        }
        const nextZoneChild = nextLine.match(/^(\s*)\(([A-Za-z_][A-Za-z0-9_]*)/);
        if (!repairing && sawPolygon && line === `${zoneIndent})`
            && nextZoneChild?.[1] === zoneIndent && zoneChildren.has(nextZoneChild[2])) {
            repairing = true;
            changed = true;
            continue;
        }
        if (repairing) {
            const boardLevel = line.match(/^(\s*)\(([A-Za-z_][A-Za-z0-9_]*)/);
            if (boardLevel && boardLevel[1].length <= zoneIndent.length && !zoneChildren.has(boardLevel[2])) {
                result.push(`${zoneIndent})`);
                repairing = false;
                changed = true;
                if (boardLevel[2] === 'zone') {
                    zoneIndent = boardLevel[1];
                    sawPolygon = false;
                    zoneDepth = lineDepthDelta;
                }
                else {
                    zoneDepth = 0;
                }
            }
            else if (line.trim() === ')' && zoneDepth === 1 && line !== `${zoneIndent})`) {
                result.push(`${zoneIndent})`);
                repairing = false;
                zoneDepth = 0;
                changed = true;
            }
            else {
                zoneDepth += lineDepthDelta;
                if (zoneDepth <= 0) {
                    zoneDepth = 0;
                    repairing = false;
                }
            }
        }
        else if (!zoneStart && zoneDepth > 0) {
            zoneDepth += lineDepthDelta;
            if (zoneDepth <= 0) {
                zoneDepth = 0;
            }
        }
        result.push(line);
    }
    if (repairing) {
        result.push(`${zoneIndent})`);
        changed = true;
    }
    return changed ? result.join(newline) : text;
}
/** The pad/track/via exclusion clearance actually used for a zone fill: the
 *  larger of the zone's own local override and whatever real project-level
 *  floors are available — never just one guessed number. */
export function resolveZoneClearanceMm(zone, designSettings) {
    return Math.max(zone.getClearance(), designSettings?.minClearanceMm ?? 0, designSettings?.defaultNetClassClearanceMm ?? 0);
}
export function pointsNear(ax, ay, bx, by) {
    return Math.abs(ax - bx) < JUNCTION_POINT_EPS && Math.abs(ay - by) < JUNCTION_POINT_EPS;
}
/** Circumcenter of the 3 points defining a symbol-body arc — the pivot real
 *  KiCad rotates/mirrors an arc around (its `m_arcCenter`), as opposed to
 *  its `start` point. Returns null on a degenerate/near-collinear triple
 *  (start/mid/end all on one line has no finite circumcenter); callers fall
 *  back to `start` as the pivot in that case. */
export function arcCircumcenter(p1, p2, p3) {
    const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
    if (Math.abs(d) < 1e-9) {
        return null;
    }
    const p1sq = p1.x * p1.x + p1.y * p1.y;
    const p2sq = p2.x * p2.x + p2.y * p2.y;
    const p3sq = p3.x * p3.x + p3.y * p3.y;
    const x = (p1sq * (p2.y - p3.y) + p2sq * (p3.y - p1.y) + p3sq * (p1.y - p2.y)) / d;
    const y = (p1sq * (p3.x - p2.x) + p2sq * (p1.x - p3.x) + p3sq * (p2.x - p1.x)) / d;
    return { x, y };
}
/** Quantized so two truly-collinear directions compare equal (Set dedup) —
 *  a straight 2-wire chain/extension must NOT look like 2 distinct exits. */
export function quantizedAngle(fromX, fromY, toX, toY) {
    const raw = Math.atan2(toY - fromY, toX - fromX);
    const normalized = ((raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return Math.round(normalized * 100000) / 100000;
}
/** True only for a STRICTLY interior point — an actual endpoint is handled
 *  separately by the caller (an "ender" contributes one exit angle, a
 *  mid-segment hit contributes two — see junctionNeededAt's doc comment). */
export function pointLiesOnSegmentInterior(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < JUNCTION_POINT_EPS * JUNCTION_POINT_EPS) {
        return false;
    }
    const t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    if (t <= JUNCTION_POINT_EPS || t >= 1 - JUNCTION_POINT_EPS) {
        return false;
    }
    const projX = x1 + t * dx, projY = y1 + t * dy;
    return Math.hypot(px - projX, py - projY) < JUNCTION_POINT_EPS;
}
export function cubicBezierToPolyline(p0, p1, p2, p3, steps = 32) {
    const points = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const a = mt * mt * mt;
        const b = 3 * mt * mt * t;
        const c = 3 * mt * t * t;
        const d = t * t * t;
        points.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
    }
    return points;
}
export function computeWireBend(from, to, mode) {
    if (mode === 'free' || from.x === to.x || from.y === to.y) {
        return null;
    }
    if (mode === '45') {
        const dx = to.x - from.x, dy = to.y - from.y;
        const adx = Math.abs(dx), ady = Math.abs(dy);
        if (adx === ady)
            return null;
        const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
        return adx > ady
            ? { x: from.x + sx * (adx - ady), y: from.y }
            : { x: from.x, y: from.y + sy * (ady - adx) };
    }
    return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
        ? { x: to.x, y: from.y }
        : { x: from.x, y: to.y };
}
