// Quick sanity test for the ported R*-tree: insert/remove/search round-trip.
import { DYNAMIC_RTREE } from '../connectivity/DynamicRtree';

const NUMDIMS = 3;
const N = 500;

const rtree = new DYNAMIC_RTREE<number>(NUMDIMS, 16);

// Insert N random boxes
for (let i = 0; i < N; i++) {
	const x = Math.floor(Math.random() * 1000);
	const y = Math.floor(Math.random() * 1000);
	const layer = i % 4; // 0..3
	rtree.Insert([layer, x, y], [layer, x + 10, y + 10], i);
}

// Query a box covering everything; expect all N back
let found = 0;
rtree.Search([-1, -1, -1], [10, 2000, 2000], () => { found++; return true; });
if (found !== N) {
	console.error(`FAIL: full query found ${ found }, expected ${ N }`);
	process.exit(1);
}

// Build a second tree with stored boxes for naive comparison
const boxes: number[][] = [];
const rtree2 = new DYNAMIC_RTREE<number>(NUMDIMS, 16);
for (let i = 0; i < N; i++) {
	const x = Math.floor(Math.random() * 1000);
	const y = Math.floor(Math.random() * 1000);
	const layer = i % 4;
	boxes[i] = [layer, x, y, x + 10, y + 10];
	rtree2.Insert([layer, x, y], [layer, x + 10, y + 10], i);
}

const qmin = [0, 500, 500];
const qmax = [0, 520, 520];

const naive: number[] = [];
for (let i = 0; i < N; i++) {
	const b = boxes[i]!;
	if (
		b[0]! <= qmax[0]! && b[3]! >= qmin[0]! &&
		b[1]! <= qmax[1]! && b[4]! >= qmin[1]! &&
		b[2]! <= qmax[2]! && b[5]! >= qmin[2]!
	) {
		naive.push(i);
	}
}
const rtreeHits: number[] = [];
rtree2.Search(qmin, qmax, (d) => { rtreeHits.push(d); return true; });
rtreeHits.sort((a, b) => a - b);
naive.sort((a, b) => a - b);
if (JSON.stringify(rtreeHits) !== JSON.stringify(naive)) {
	console.error(`FAIL: query mismatch\n rtree: ${ rtreeHits }\n naive: ${ naive }`);
	process.exit(1);
}

// Remove half the items, verify the rest still query correctly
for (let i = 0; i < N; i += 2) {
	const b = boxes[i]!;
	if (!rtree2.Remove([b[0]!, b[1]!, b[2]!], [b[0]!, b[3]!, b[4]!], i)) {
		console.error(`FAIL: remove(${ i }) returned false`);
		process.exit(1);
	}
}
const remaining: number[] = [];
for (let i = 1; i < N; i += 2) {
	remaining.push(i);
}
const afterRemove: number[] = [];
rtree2.Search([-1, -1, -1], [10, 2000, 2000], (d) => { afterRemove.push(d); return true; });
afterRemove.sort((a, b) => a - b);
if (JSON.stringify(afterRemove) !== JSON.stringify(remaining)) {
	console.error(`FAIL: after-remove full query\n got: ${ afterRemove }\n exp: ${ remaining }`);
	process.exit(1);
}

// RemoveAll
rtree2.RemoveAll();
let afterAll = 0;
rtree2.Search([-1, -1, -1], [10, 2000, 2000], () => { afterAll++; return true; });
if (afterAll !== 0) {
	console.error(`FAIL: RemoveAll left ${ afterAll } items`);
	process.exit(1);
}

// Visitor early-stop
let visits = 0;
rtree.Search([-1, -1, -1], [10, 2000, 2000], () => { visits++; return visits < 3; });
if (visits !== 3) {
	console.error(`FAIL: early stop visited ${ visits }, expected 3`);
	process.exit(1);
}

console.log('R-tree sanity test PASSED');
