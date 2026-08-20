import assert from 'assert';
import { sexprParenDelta, repairLegacyMalformedZoneText, readBoardOrigin } from '../utils';
import { Vec2 } from '../math/Vec2';

// sexprParenDelta should ignore parentheses inside quoted strings
assert.strictEqual(sexprParenDelta('(a (b) "(ignored)" )'), 0);
assert.strictEqual(sexprParenDelta('(( pts'), 2);

// repairLegacyMalformedZoneText should leave well-formed text unchanged
const well = '(zone (layer F.Cu) (polygon (pts (xy 0 0) (xy 1 1))))';
assert.strictEqual(repairLegacyMalformedZoneText(well), well);

// A malformed input case: simplified example where (( pts appears
const malformed = '(zone\n  (( pts\n    (xy 0 0)\n    (xy 1 1)\n  )\n)\n';
const repaired = repairLegacyMalformedZoneText(malformed);
assert.ok(repaired.includes('(polygon'));
assert.ok(repaired.includes('(pts'));

// readBoardOrigin should parse a mocked setup node
const mock = {
	findFirstChildByName(name: string) {
		if (name === 'grid_origin') return { attributes: [{ value: '10' }, { value: '20' }] };
		return null;
	}
};
const origin = readBoardOrigin(mock as any, 'grid_origin');
assert.ok(origin instanceof Vec2);
assert.strictEqual(origin.x, 10);
assert.strictEqual(origin.y, 20);

console.log('utils tests passed');
