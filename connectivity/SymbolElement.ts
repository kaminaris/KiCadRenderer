/*
 * Shared helpers for reading a placed schematic symbol's properties
 * (Reference / Value / Footprint / Datasheet) from its `(property ...)`
 * children. Mirrors KicadElementSymbol.getReference (which uses
 * getPropertyByName from the WithProperties mixin).
 *
 * These are the single source of truth for the netlist/connection-graph
 * extractors, so they consistently read the AST the same way.
 */

/**
 * Reads a symbol `(property "<Name>" "<value>" ...)` child's value via the
 * WithProperties mixin's getPropertyByName. Duck-typed so it works whether the
 * caller has a full KicadElementSymbol or a loosely-typed `any`.
 */
export function symbolProperty(el: any, aName: string): string {
	if (!el) return '';
	if (typeof el.getPropertyByName === 'function') {
		try {
			const prop = el.getPropertyByName(aName);
			return prop?.propertyValue ?? '';
		} catch {
			// fall through
		}
	}
	// Fallback: walk children for a (property "<Name>" ...).
	for (const c of el?.children ?? []) {
		if (c?.name === 'property' && c?.key === aName) {
			return c?.value ?? '';
		}
	}
	return '';
}

/** The symbol's Reference (mirrors getReference). */
export function symbolReference(el: any): string {
	if (el && typeof el.getReference === 'function') {
		return el.getReference() ?? '';
	}
	return symbolProperty(el, 'Reference');
}

/** The symbol's Value. */
export function symbolValue(el: any): string {
	return symbolProperty(el, 'Value');
}

/** The symbol's Footprint. */
export function symbolFootprint(el: any): string {
	return symbolProperty(el, 'Footprint');
}

/** The symbol's Datasheet. */
export function symbolDatasheet(el: any): string {
	return symbolProperty(el, 'Datasheet');
}
