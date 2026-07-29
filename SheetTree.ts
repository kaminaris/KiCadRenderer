// Builds a full hierarchical sheet tree, ROOTED AT THE PROJECT'S ROOT
// schematic — unlike the currently-displayed scene (which only knows about
// its OWN direct children), this walks the whole hierarchy up front so a
// caller can render a persistent navigator panel that doesn't change shape
// as the user descends/climbs between sheets, matching real KiCad's own
// "Sheet Navigator" behavior (it's rooted at the project root, not at
// whatever sheet is currently open).
//
// Deliberately framework/IO-agnostic like KicadRenderSession: the caller
// supplies `fetchText`, so this works identically against `fetch()` (the
// demo) or an API service call (the Angular viewer).

import { KicadParser } from '@kicad-io/KicadParser';
import { SchematicPainter } from './paint/SchematicPainter';
import { registerDefaultKicadClasses } from './RegisterDefaultClasses';
import { dirnameGeneric, joinPathGeneric } from './PathUtils';

export interface SheetTreeNode {
	/** Absolute (server-local) path to this sheet's .kicad_sch file. */
	path: string;
	/** Display name — the parent sheet's Sheetname for this reference, or
	 * the caller-supplied project name for the root node. */
	label: string;
	children: SheetTreeNode[];
}

const defaultMaxDepth = 12;

/**
 * Recursively walks the hierarchy starting from the root schematic,
 * fetching and parsing every descendant sheet purely to discover ITS
 * children (via SchematicPainter.extractSheets — no full scene build).
 * `textCache` is populated as a side effect (path -> raw file text) so a
 * caller can reuse it for actual navigation without re-fetching a sheet
 * it's about to display anyway.
 */
export async function buildSheetTree(
	rootPath: string,
	rootText: string,
	rootLabel: string,
	fetchText: (path: string) => Promise<string>,
	textCache: Map<string, string> = new Map(),
	maxDepth: number = defaultMaxDepth
): Promise<SheetTreeNode> {
	textCache.set(rootPath, rootText);
	return buildNode(rootPath, rootText, rootLabel, fetchText, textCache, new Set([rootPath]), maxDepth);
}

async function buildNode(
	path: string,
	text: string,
	label: string,
	fetchText: (path: string) => Promise<string>,
	textCache: Map<string, string>,
	visited: Set<string>,
	depthRemaining: number
): Promise<SheetTreeNode> {
	const node: SheetTreeNode = { path, label, children: [] };
	if (depthRemaining <= 0) {
		return node;
	}

	registerDefaultKicadClasses();
	const parser = new KicadParser();
	const rootElement = parser.parse(text);
	const sheets = new SchematicPainter().extractSheets({ rootElement });
	const dir = dirnameGeneric(path);

	for (const sheet of sheets) {
		const childPath = joinPathGeneric(dir, sheet.file);
		// A sheet referencing an ancestor (or itself) would recurse forever
		// — real KiCad hierarchies are trees/DAGs, not expected to have
		// cycles, but a misconfigured project could still produce one.
		if (visited.has(childPath)) {
			continue;
		}

		let childText = textCache.get(childPath);
		if (childText === undefined) {
			try {
				childText = await fetchText(childPath);
				textCache.set(childPath, childText);
			}
			catch (err) {
				// Broken/missing reference — still show the node (so the
				// tree reflects what the ROOT schematic references), just
				// without descending further into it.
				console.error(`Failed to fetch sheet "${ childPath }" for hierarchy tree`, err);
				node.children.push({ path: childPath, label: sheet.name || sheet.file, children: [] });
				continue;
			}
		}

		const childVisited = new Set(visited);
		childVisited.add(childPath);
		node.children.push(
			await buildNode(childPath, childText, sheet.name || sheet.file, fetchText, textCache, childVisited, depthRemaining - 1)
		);
	}

	return node;
}

/** Finds the path-from-root to a given node (inclusive of the node itself)
 * — used to reconstruct breadcrumbs when a tree click jumps directly to a
 * deeply-nested sheet, not just one level down from the current one. */
export function findTreePath(root: SheetTreeNode, targetPath: string): SheetTreeNode[] | null {
	if (root.path === targetPath) {
		return [root];
	}
	for (const child of root.children) {
		const found = findTreePath(child, targetPath);
		if (found) {
			return [root, ...found];
		}
	}
	return null;
}
