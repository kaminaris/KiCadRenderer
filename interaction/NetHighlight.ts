/*
 * Ported from KiCad source:
 *   eeschema/tools/sch_highlight_tool.cpp / pcbnew/tools/board_highlight.cpp
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The net-highlight brush: given a world point, resolve which net is under
 * the cursor (via the connectivity / nearest-pad-track lookup) and return the
 * net id to highlight. The session's live brush (highlightBoardNetAtScreen/
 * clearBoardNetHighlight) is the renderer; this small canonical helper
 * centralizes the "net under point" lookup so any caller gets the same answer.
 *
 * Units: mm.
 */

import { Vec2 } from '../math/Vec2';

/** A connectivity lookup the highlight brush needs. */
export interface NetLookup {
	/** The net id at a world point (0/negative = none), plus its name. */
	netAtPoint(aPoint: Vec2, aTolerance: number): { netId: number | null; netName: string | null };
}

/**
 * Resolves the net to highlight for a world point under the cursor.
 * Returns null when nothing (or only a no-net item) is under the point.
 */
export function netToHighlight(aLookup: NetLookup, aPoint: Vec2, aTolerance: number): { netId: number | null; netName: string | null } {
	const hit = aLookup.netAtPoint(aPoint, aTolerance);
	if (hit.netId === null || hit.netId <= 0) {
		return { netId: null, netName: null };
	}
	return hit;
}

/**
 * The net-highlight brush state: exactly one net is highlighted at a time
 * (same as KiCad's tool); calling Set on a different net replaces it, null
 * clears. Mirrors the board_highlight tool's toggle/replace behaviour.
 */
export class NET_HIGHLIGHT {
	private netId: number | null = null;
	private netName: string | null = null;
	private enabled = false;

	/** Whether the brush is active at all. */
	IsActive(): boolean {
		return this.enabled;
	}

	/** The currently highlighted net (null if none). */
	NetId(): number | null {
		return this.netId;
	}

	NetName(): string | null {
		return this.netName;
	}

	/** Highlights `aNetId` (replacing any previous), enabling the brush. */
	Set(aNetId: number, aNetName: string): void {
		this.netId = aNetId;
		this.netName = aNetName;
		this.enabled = true;
	}

	/** Clears the brush (no net highlighted). */
	Clear(): void {
		this.netId = null;
		this.netName = null;
		this.enabled = false;
	}
	/** Enables/disables the brush without changing the selection. */
	SetEnabled(aEnabled: boolean): void {
		this.enabled = aEnabled;
	}
}
