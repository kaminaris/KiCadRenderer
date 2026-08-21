import { BooleanOp } from '@clipper2-ts/engine';
import { InflatePaths } from '@clipper2-ts/offset';
export const tsClipperEngine = {
    name: 'clipper2-ts',
    booleanOp: BooleanOp,
    inflatePaths: InflatePaths,
};
let activeEngine = tsClipperEngine;
/** Whatever engine is currently active. Never null/undefined, so every
 *  caller can use it unconditionally with no availability check. */
export function getClipperEngine() {
    return activeEngine;
}
/** Swaps the active backend. Passing tsClipperEngine explicitly is a valid,
 *  deliberate way to revert (e.g. a caller that detects its WASM engine
 *  failed mid-session for some reason). */
export function setClipperEngine(engine) {
    activeEngine = engine;
}
