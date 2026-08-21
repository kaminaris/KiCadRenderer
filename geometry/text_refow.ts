/*
 * Ported from KiCad source:
 *   libs/kicad/kiface/... (KIFONT) text metrics — reflow concept
 *   common/kicad_string.cpp utilities
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Text reflow: wraps a string into lines so it fits a box, given the per-char
 * advance (font size). Mirrors KiCad's word-wrap used by text boxes / labels.
 * Characters are treated as monospace at `aCharWidth` mm each.
 */

/**
 * Wraps `aText` into lines each fitting within `aMaxWidth` mm, assuming each
 * character is `aCharWidth` mm wide. Words that exceed the width are hard-split.
 * Returns the array of lines (no trailing newline).
 */
export function wrapText(
	aText: string,
	aCharWidth: number,
	aMaxWidth: number
): string[] {
	if (aMaxWidth <= 0 || aCharWidth <= 0) {
		return aText.split('\n');
	}

	const maxChars = Math.max(1, Math.floor(aMaxWidth / aCharWidth));
	const lines: string[] = [];
	const paragraphs = aText.split('\n');

	for (const para of paragraphs) {
		const words = para.split(/(\s+)/);
		let line = '';
		for (const word of words) {
			if (word === '') {
				continue;
			}
			if (word.trim() === '' && !line) {
				// leading whitespace at line start — keep minimal
				line = '';
				continue;
			}
			if ((line.length + (line ? 1 : 0) + word.length) <= maxChars) {
				line = line ? line + ' ' + word : word;
			} else {
				if (line) {
					lines.push(line);
					line = '';
				}
				// hard-split words longer than the line
				let w = word;
				while (w.length > maxChars) {
					lines.push(w.slice(0, maxChars));
					w = w.slice(maxChars);
				}
				line = w;
			}
		}
		if (line) {
			lines.push(line);
		}
	}

	return lines;
}

/**
 * The number of lines a wrapped text produces.
 */
export function wrapLineCount(aText: string, aCharWidth: number, aMaxWidth: number): number {
	return wrapText(aText, aCharWidth, aMaxWidth).length;
}

/**
 * Reflows a text into a column/box and joins with newlines (KiCad-style
 * "reflow to width").
 */
export function reflowText(
	aText: string,
	aCharWidth: number,
	aMaxWidth: number
): string {
	return wrapText(aText, aCharWidth, aMaxWidth).join('\n');
}
