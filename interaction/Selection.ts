/*
 * Ported from KiCad source:
 *   pcbnew/tools/selection_tool.cpp / selection.h (SELECTION_TOOL, SELECTION)
 *   common/tool/tool_interactive.cpp (event-driven select)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The canonical selection model: a SELECTION (ordered set of selected item
 * ids) and the SELECTION_TOOL state machine that maintains it through clicks,
 * box-selects, and modifier-key add/remove/toggle — the same one KiCad's
 * select tool runs. Item identity is an opaque id (paint id / AST ref); the
 * session maps ids to live items.
 */

/** How a click adds/removes items vs. replaces. */
export enum SELECT_MODE {
	/** Replace the selection with the hit. */
	REPLACE = 0,
	/** Add the hit to the selection. */
	ADD = 1,
	/** Toggle the hit in/out of the selection. */
	TOGGLE = 2,
	/** Subtract the hit from the selection. */
	SUBTRACT = 3,
}

/**
 * The selection set. Mirrors KiCad's SELECTION: an ordered list of selectable
 * ids with helpers to test membership and enumerate.
 */
export class SELECTION {
	private m_items: string[] = [];

	/** The number of selected items. */
	Size(): number {
		return this.m_items.length;
	}

	IsEmpty(): boolean {
		return this.m_items.length === 0;
	}

	/** Whether `aId` is currently selected. */
	Contains(aId: string): boolean {
		return this.m_items.includes(aId);
	}

	Add(aId: string): void {
		if (!this.m_items.includes(aId)) {
			this.m_items.push(aId);
		}
	}

	Remove(aId: string): void {
		const i = this.m_items.indexOf(aId);
		if (i >= 0) {
			this.m_items.splice(i, 1);
		}
	}

	Toggle(aId: string): void {
		if (this.Contains(aId)) {
			this.Remove(aId);
		} else {
			this.Add(aId);
		}
	}

	Clear(): void {
		this.m_items = [];
	}

	/** The ids, in selection order (first selected first). */
	Ids(): readonly string[] {
		return this.m_items;
	}

	/** Adds several ids. */
	AddMany(aIds: Iterable<string>): void {
		for (const id of aIds) {
			this.Add(id);
		}
	}

	/** A copy of this selection. */
	Clone(): SELECTION {
		const s = new SELECTION();
		s.m_items = [...this.m_items];
		return s;
	}
}

/** How the user is selecting right now (nothing / point / rectangle). */
export type SelectionPhase = 'idle' | 'point' | 'box';

/** A single select action event fed to the tool. */
export interface SelectionEvent {
	/** The item under the cursor (or empty for empty-area click). */
	hits: string[];
	/** The selection modifier for this click (Shift/CTRL semantics). */
	mode: SELECT_MODE;
	/** Whether this click begins a rectangle (drag) select. */
	startBox: boolean;
}

/** Result of feeding an event; contains the box being drawn (if any). */
export interface SelectionResult {
	/** The current selection after processing. */
	selection: SELECTION;
	/** The live box (start..end) during a box-select, or null. */
	box: { a: { x: number; y: number }; b: { x: number; y: number } } | null;
	/** True if the click was an empty-area click that cleared the selection. */
	cleared: boolean;
}

/**
 * The selection tool state machine. Mirrors SELECTION_TOOL's core: a click
 * replaces (or adds/toggles per modifier); an empty-area click clears; a drag
 * becomes a box select that replaces the selection with everything inside.
 * Items are opaque ids; a caller supplies geometry (via a lookback) for the
 * box-select membership test.
 */
export class SELECTION_TOOL {
	private selection = new SELECTION();
	private phase: SelectionPhase = 'idle';
	private boxStart: { x: number; y: number } | null = null;
	private boxCur: { x: number; y: number } | null = null;
	/** Optional geometry lookup (id -> bbox points) used for box membership. */
	private geomById: ((id: string) => { x: number; y: number }[]) | null = null;

	/** Binds the geometry lookup the tool uses for box-select containment. */
	SetGeometryLookup(fn: ((id: string) => { x: number; y: number }[]) | null): void {
		this.geomById = fn;
	}

	/** The current selection. */
	GetSelection(): SELECTION {
		return this.selection;
	}

	/** Programmatically select a single id (replacing). */
	SelectOnly(aId: string): SELECTION {
		this.selection.Clear();
		this.selection.Add(aId);
		this.phase = 'idle';
		return this.selection;
	}

	/** Clears the selection. */
	ClearSelection(): void {
		this.selection.Clear();
		this.phase = 'idle';
		this.boxStart = null;
		this.boxCur = null;
	}

	/** Whether a selection is in progress. */
	IsActive(): boolean {
		return this.phase !== 'idle';
	}

	/**
	 * Called for a click (single or box-begin). Applies the modifier to the
	 * hits; if empty-area and mode REPLACE it clears. Returns the result.
	 */
	Click(aEvent: SelectionEvent, aPoint: { x: number; y: number }): SelectionResult {
		if (aEvent.startBox) {
			this.phase = 'box';
			this.boxStart = aPoint;
			this.boxCur = aPoint;
			return { selection: this.selection, box: { a: aPoint, b: aPoint }, cleared: false };
		}

		this.phase = 'idle';
		this.boxStart = null;
		this.boxCur = null;

		if (aEvent.hits.length === 0) {
			// Empty-area click: replace-mode clears; add/toggle/subtract are
			// no-ops on empty (KiCad keeps them from clearing).
			if (aEvent.mode === SELECT_MODE.REPLACE) {
				const cleared = !this.selection.IsEmpty();
				this.selection.Clear();
				return { selection: this.selection, box: null, cleared };
			}
			return { selection: this.selection, box: null, cleared: false };
		}

		const mode = aEvent.mode;
		if (mode === SELECT_MODE.REPLACE) {
			this.selection.Clear();
			this.selection.AddMany(aEvent.hits);
		} else if (mode === SELECT_MODE.ADD) {
			this.selection.AddMany(aEvent.hits);
		} else if (mode === SELECT_MODE.TOGGLE) {
			for (const id of aEvent.hits) {
				this.selection.Toggle(id);
			}
		} else if (mode === SELECT_MODE.SUBTRACT) {
			for (const id of aEvent.hits) {
				this.selection.Remove(id);
			}
		}
		return { selection: this.selection, box: null, cleared: false };
	}

	/**
	 * Extends the ongoing box select to `aPoint`. Members within the box are
	 * live-tracked (the caller is expected to call EndBox() to commit the
	 * REPLACE semantics with the contained set).
	 */
	UpdateBox(aPoint: { x: number; y: number }): SelectionResult | null {
		if (this.phase !== 'box' || !this.boxStart) {
			return null;
		}
		this.boxCur = aPoint;
		return { selection: this.selection, box: { a: this.boxStart, b: aPoint }, cleared: false };
	}

	/**
	 * The ids currently inside the box (from the geometry lookup). Returns
	 * null while not in a box or without a geometry lookup.
	 */
	BoxContents(): string[] | null {
		if (this.phase !== 'box' || !this.boxStart || !this.boxCur || !this.geomById) {
			return null;
		}
		const minX = Math.min(this.boxStart.x, this.boxCur.x);
		const minY = Math.min(this.boxStart.y, this.boxCur.y);
		const maxX = Math.max(this.boxStart.x, this.boxCur.x);
		const maxY = Math.max(this.boxStart.y, this.boxCur.y);
		const inside: string[] = [];
		for (const id of this.selection.Ids()) {
			const pts = this.geomById(id);
			if (!pts) {
				continue;
			}
			for (const p of pts) {
				if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
					inside.push(id);
					break;
				}
			}
		}
		return inside;
	}

	/**
	 * Ends the box select: replaces the selection with the box contents
	 * (REPLACE semantics) and returns to idle.
	 */
	EndBox(): SELECTION {
		if (this.phase === 'box') {
			const contents = this.BoxContents();
			this.selection.Clear();
			if (contents) {
				this.selection.AddMany(contents);
			}
		}
		this.phase = 'idle';
		this.boxStart = null;
		this.boxCur = null;
		return this.selection;
	}
}
