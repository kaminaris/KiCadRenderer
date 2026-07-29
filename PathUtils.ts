// Minimal, dependency-free path helpers for resolving a hierarchical
// sheet's relative Sheetfile against the CURRENTLY-loaded schematic's own
// path — deliberately not Node's `path` module, since this file is shared
// with the browser (both the standalone demo and the Angular web app import
// it), and project paths here are opaque strings from the server/API
// (`C:\...` or `C:/...`), not filesystem paths this code ever touches
// directly.

/** Directory portion of a path, tolerant of both '/' and '\' separators
 * (server-provided paths are Windows-style; the browser never normalizes
 * them). Returns '' if there's no separator at all. */
export function dirnameGeneric(path: string): string {
	const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return idx >= 0 ? path.slice(0, idx) : '';
}

/** File-name portion of a path (no directory), tolerant of both '/' and
 * '\' separators — same reasoning as dirnameGeneric. */
export function basenameGeneric(path: string): string {
	const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Joins a directory and a (possibly itself nested, e.g. "sub/Child.kicad_sch")
 * relative file reference, using whichever separator the directory itself
 * already uses so the result stays visually consistent with the input. */
export function joinPathGeneric(dir: string, relativeFile: string): string {
	if (!dir) {
		return relativeFile;
	}
	const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
	const normalizedFile = relativeFile.replace(/[\\/]/g, sep);
	return dir.replace(/[\\/]+$/, '') + sep + normalizedFile;
}
