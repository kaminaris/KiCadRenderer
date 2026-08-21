import { buildRatsnestFromAnchors } from './BoardRatsnestBench';

// Worker message protocol:
// { anchorsByNet: Record<string, {x:number,y:number,island:number}[]>, bench?: boolean }

self.addEventListener('message', (ev: MessageEvent) => {
	const data = ev.data as { anchorsByNet: Record<string, { x: number; y: number; island: number }[]>; bench?: boolean };
	const map = new Map<number, { x: number; y: number; island: number }[]>();
	for (const k of Object.keys(data.anchorsByNet || {})) {
		map.set(Number(k), data.anchorsByNet[k]);
	}
	try {
		const lines = buildRatsnestFromAnchors(map, !!data.bench);
		(self as DedicatedWorkerGlobalScope).postMessage({ lines });
	} catch (err) {
		(self as DedicatedWorkerGlobalScope).postMessage({ error: String(err) });
	}
});
