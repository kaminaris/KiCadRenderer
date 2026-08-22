/*
 * Ported from KiCad source:
 *   libs/kimath/src/geometry/shape_poly_set.cpp (concept only)
 *   pcbnew/undo_redo_container.h / undo_redo_container.cpp (UNDO_REDO)
 *   pcbnew/commit.h / commit.cpp (COMMIT)
 *   pcbnew/picked_list.h (PICKED_LIST)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The canonical undo/redo model: a COMMIT collects mutations (added/changed/
 * removed items) and, on Commit(), pushes one UNDO_REDO_ITEM onto the
 * UNDO_REDO stack with the data to undo (and redo). The session's existing
 * snapshot mechanism is the live implementation; this module documents the
 * canonical KiCad shape of the transaction so mutations carry an explicit
 * "invert on undo" description.
 *
 * Items are opaque (any AST element object) — matching how the web editor's
 * session stores its own element refs.
 */

/** Mirrors enum UNDO_REDO_T from pcbnew/undoredo.h. */
export enum UNDO_REDO_T {
	NOT_SPECIFIED = 0,
	ADDED = 1,
	REMOVED = 2,
	CHANGED = 3,
	INITIAL = 4,
	NEWCELL = 5,
	MULTI = 6,
	TYPE_BY_DRAWITEM = 7,
}

/** One picked change to a single item. Mirrors PICKED_LIST / PICKED_ITEM. */
export interface PICKED_ITEM {
	/** The mutated element (opaque AST ref). */
	item: unknown;
	/** What changed: added / removed / changed. */
	type: UNDO_REDO_T;
	/** The pre-edit payload for undo (e.g. prior segments, prior net). */
	undo: unknown;
	/** The post-edit payload for redo. */
	redo: unknown;
}

/** One undoable transaction (a committed COMMIT). Mirrors UNDO_REDO_ITEM. */
export interface UNDO_REDO_ITEM {
	kind: UNDO_REDO_T;
	picked: PICKED_ITEM[];
	/** Optional description (for status/UI). */
	description: string;
}

/**
 * The undo/redo stack. Mirrors KiCad's UNDO_REDO container: PushUndoItem
 * adds to the undo stack (clearing any redo branch), PushRedoItem / since
 * KiCad keeps a paired redo stack.
 */
export class UNDO_REDO {
	private m_undo: UNDO_REDO_ITEM[] = [];
	private m_redo: UNDO_REDO_ITEM[] = [];
	private m_limit = 50;

	constructor(aLimit = 50) {
		this.m_limit = aLimit;
	}

	/** The number of undoable actions available. */
	UndoCount(): number {
		return this.m_undo.length;
	}

	/** The number of redoable actions available. */
	RedoCount(): number {
		return this.m_redo.length;
	}

	/** Pushes a committed transaction onto the undo stack. Clearing the redo
	 *  branch (a new action invalidates the redo history). */
	Push(item: UNDO_REDO_ITEM): void {
		this.m_undo.push(item);
		for (let i = 0; i < this.m_undo.length; i++) {
			const total = this.m_undo[i]!.picked.length;
			if (total > 0 && total <= 5 && this.m_undo.length - i >= this.m_limit) {
				this.m_undo.splice(i, 1);
				i--;
			} else if (this.m_undo.length > this.m_limit) {
				this.m_undo.splice(0, this.m_undo.length - this.m_limit);
				break;
			}
		}
		this.m_redo.length = 0;
	}

	/** Pops the most recent undo item without applying it. */
	PopUndo(): UNDO_REDO_ITEM | null {
		return this.m_undo.pop() ?? null;
	}

	/** Consumes the next redo item (cleared by any new action). */
	PopRedo(): UNDO_REDO_ITEM | null {
		return this.m_redo.pop() ?? null;
	}

	/** The set of items affected by the most recent undo (for UI refresh). */
	Clear(): void {
		this.m_undo = [];
		this.m_redo = [];
	}
}

/**
 * The COMMIT pattern: collect mutations during a transaction, then Commit()
 * wraps them in a single UNDO_REDO_ITEM. Mirrors pcbnew/commit.{h,cpp}.
 */
export class COMMIT {
	protected m_changed: PICKED_ITEM[] = [];
	private m_description = '';

	constructor(aDescription = '') {
		this.m_description = aDescription;
	}

	/** Registers an item as ADDED by this commit. */
	Add(item: unknown): void {
		this.m_changed.push({ item, type: UNDO_REDO_T.ADDED, undo: null, redo: null });
	}

	/** Registers an item as REMOVED by this commit. */
	Remove(item: unknown, prior: unknown = null): void {
		this.m_changed.push({ item, type: UNDO_REDO_T.REMOVED, undo: prior, redo: null });
	}

	/** Registers an item as CHANGED (with its pre-edit `undo` payload). */
	Modify(item: unknown, undo: unknown, redo: unknown): void {
		this.m_changed.push({ item, type: UNDO_REDO_T.CHANGED, undo, redo });
	}

	/** Whether this commit has any recorded changes. */
	Empty(): boolean {
		return this.m_changed.length === 0;
	}

	/** Number of recorded changes. */
	Size(): number {
		return this.m_changed.length;
	}

	/** Folds the collected changes into a single UNDO_REDO_ITEM; no-op if
	 *  empty. Returns the item (for the caller to push onto an UNDO_REDO). */
	Commit(): UNDO_REDO_ITEM | null {
		if (this.m_changed.length === 0) {
			return null;
		}
		const item: UNDO_REDO_ITEM = {
			kind: UNDO_REDO_T.MULTI,
			picked: this.m_changed,
			description: this.m_description,
		};
		this.m_changed = [];
		return item;
	}

	/** Roll back everything recorded so far (no commit pushed). */
	Revert(): void {
		this.m_changed = [];
	}
}
