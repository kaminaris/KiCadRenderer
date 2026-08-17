import { BooleanOp, ClipType } from '@clipper2-ts/engine';
import { FillRule, Paths } from '@clipper2-ts/core';
import { EndType, InflatePaths, JoinType } from '@clipper2-ts/offset';

/**
 * Swappable backend for the handful of Clipper2 primitives BoardZoneFill.ts
 * needs. Real motivation: a user-reported "zone fill takes ~4s here, real
 * KiCad does it in <2s" — a throwaway benchmark (shared/kicad-io/test/
 * zoneFillEngineBenchmark.test.ts) against a real 6-layer board fixture
 * showed the Clipper2 engine itself is ~90% of that time, and that
 * clipper2-wasm (real Clipper2 C++ compiled to WASM) runs the exact same
 * boolean/inflate workload ~2.7x faster than this repo's hand-ported TS
 * engine.
 *
 * Two implementations exist:
 *  - tsClipperEngine (this file's own default, below) — the pure-TS
 *    clipper2-ts port. Always available, synchronous, zero risk. Every
 *    caller that never explicitly upgrades (tests, this benchmark, or a
 *    consumer that skips the async step) keeps using exactly this, so nothing
 *    about existing behavior changes unless something opts in.
 *  - clipper2-wasm, wired in from apps/kicad-viewer's zone-fill worker via
 *    setClipperEngine() after an async load. That loading step needs
 *    bundler-specific .wasm asset resolution (Vite's `?url` import), so it
 *    deliberately does NOT live here — kicad-render stays decoupled from the
 *    app's own bundler setup, the same reasoning KicadRenderSession.ts's own
 *    header comment gives for why registerKicadIoClasses keeps this package
 *    decoupled from @kicad-io. WebAssembly can be genuinely unavailable in
 *    some environments (old browsers, hardened/sandboxed embeddings, a CSP
 *    blocking wasm-unsafe-eval) — the loader is expected to fall back to
 *    tsClipperEngine (i.e. just not call setClipperEngine) rather than throw,
 *    so this always keeps working, just potentially slower.
 */
export interface ClipperEngine {
	readonly name: string;
	booleanOp(clipType: ClipType, fillRule: FillRule, subjects: Paths, clips: Paths): Paths;
	inflatePaths(paths: Paths, delta: number, joinType: JoinType, endType: EndType, miterLimit?: number): Paths;
}

export const tsClipperEngine: ClipperEngine = {
	name: 'clipper2-ts',
	booleanOp: BooleanOp,
	inflatePaths: InflatePaths,
};

let activeEngine: ClipperEngine = tsClipperEngine;

/** Whatever engine is currently active. Never null/undefined, so every
 *  caller can use it unconditionally with no availability check. */
export function getClipperEngine(): ClipperEngine {
	return activeEngine;
}

/** Swaps the active backend. Passing tsClipperEngine explicitly is a valid,
 *  deliberate way to revert (e.g. a caller that detects its WASM engine
 *  failed mid-session for some reason). */
export function setClipperEngine(engine: ClipperEngine): void {
	activeEngine = engine;
}
