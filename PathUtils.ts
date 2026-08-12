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

/** File extension including the dot (e.g. ".kicad_sch"), or '' if there
 * isn't one — mirrors Node's path.extname, separator-tolerant like the rest
 * of this file. */
export function extnameGeneric(path: string): string {
	const base = basenameGeneric(path);
	const idx = base.lastIndexOf('.');
	// A leading dot with nothing before it (".gitignore"-style) has no
	// extension, matching Node's path.extname behavior.
	return idx > 0 ? base.slice(idx) : '';
}

/** True for a Windows drive-letter path ("C:\...", "C:/...") or a leading
 * '/'/'\' root — the only "absolute" shapes a KiCad sheet reference could
 * realistically use. Note: an adapter backed by a browser directory handle
 * (no real OS filesystem access) cannot actually RESOLVE such a path even
 * when this returns true — that's an inherent sandbox limitation, not a bug
 * in this function. */
export function isAbsoluteGeneric(path: string): boolean {
	return /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
}

/** Collapses '.'/'..' segments generically (no real filesystem, so this is
 * pure string math, tolerant of both separators like the rest of this
 * file) — used where kicad-io's PathUtils.resolve() is asked to normalize a
 * single already-joined path rather than combine several roots. */
export function resolvePathGeneric(...paths: string[]): string {
	const joined = paths.reduce((acc, p) => (acc ? joinPathGeneric(acc, p) : p), '');
	const sep = joined.includes('\\') && !joined.includes('/') ? '\\' : '/';
	const leadingSlash = /^[\\/]/.test(joined);
	const segments = joined.split(/[\\/]+/).filter(Boolean);
	const resolved: string[] = [];
	for (const segment of segments) {
		if (segment === '.') {
			continue;
		}
		if (segment === '..') {
			// A drive-letter root ("C:") or an already-empty stack has
			// nothing to pop — keep the '..' literally rather than losing it,
			// same as Node's path.resolve would for an under-rooted path.
			if (resolved.length && resolved[resolved.length - 1] !== '..' && !/^[a-zA-Z]:$/.test(resolved[0]!)) {
				resolved.pop();
			}
			else if (resolved.length > 1) {
				resolved.pop();
			}
			else {
				resolved.push(segment);
			}
			continue;
		}
		resolved.push(segment);
	}
	return (leadingSlash ? sep : '') + resolved.join(sep);
}
