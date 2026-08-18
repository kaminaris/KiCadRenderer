/** Identifies the image formats KiCad embeds and reads their pixel extent
 * without waiting for browser image decoding. This keeps hit testing and the
 * initial fit-to-page correct even while the actual texture loads. */
export function embeddedImageInfo(data: string): {
	width: number;
	height: number;
	mimeType: string;
	ppi: number;
	legacyPpi: number;
} | null {
	const byteAt = (index: number) => index < data.length ? data.charCodeAt(index) & 0xff : 0;
	const be16 = (index: number) => (byteAt(index) << 8) | byteAt(index + 1);
	const be32 = (index: number) => ((byteAt(index) * 0x1000000) + (byteAt(index + 1) << 16) + (byteAt(index + 2) << 8)
		+ byteAt(index + 3)) >>> 0;
	const le16 = (index: number) => byteAt(index) | (byteAt(index + 1) << 8);
	if (data.length >= 24 && byteAt(0) === 0x89 && byteAt(1) === 0x50 && byteAt(2) === 0x4e && byteAt(3) === 0x47) {
		let ppi = 300;
		let legacyPpi = 300;
		let chunk = 8;
		while (chunk + 12 <= data.length) {
			const length = be32(chunk);
			if (length > data.length - chunk - 12) break;
			if (data.slice(chunk + 4, chunk + 8) === 'pHYs' && length >= 9 && byteAt(chunk + 16) === 1) {
				const pixelsPerMeter = be32(chunk + 8);
				const parsedPpi = Math.round((pixelsPerMeter / 100) * 2.54);
				const parsedLegacyPpi = Math.round(Math.floor(pixelsPerMeter / 100) * 2.54);
				if (parsedPpi > 1) ppi = parsedPpi;
				if (parsedLegacyPpi > 1) legacyPpi = parsedLegacyPpi;
				break;
			}
			chunk += length + 12;
		}
		return { width: be32(16), height: be32(20), mimeType: 'image/png', ppi, legacyPpi };
	}
	if (data.length >= 10 && data.slice(0, 3) === 'GIF') {
		return { width: le16(6), height: le16(8), mimeType: 'image/gif', ppi: 300, legacyPpi: 300 };
	}
	if (data.length >= 4 && byteAt(0) === 0xff && byteAt(1) === 0xd8) {
		let index = 2;
		let ppi = 300;
		while (index + 8 < data.length) {
			if (byteAt(index) !== 0xff) {
				index++;
				continue;
			}
			while (byteAt(index) === 0xff) index++;
			const marker = byteAt(index++);
			if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			const length = be16(index);
			if (length < 2 || index + length > data.length) break;
			const segmentData = index + 2;
			if (marker === 0xe0 && length >= 14 && data.slice(segmentData, segmentData + 5) === 'JFIF\0') {
				const unit = byteAt(segmentData + 7);
				const density = be16(segmentData + 8);
				const parsedPpi = unit === 1 ? density : unit === 2 ? Math.round(density * 2.54) : 0;
				if (parsedPpi > 1) ppi = parsedPpi;
			}
			if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
				return { width: be16(index + 5), height: be16(index + 3), mimeType: 'image/jpeg', ppi, legacyPpi: ppi };
			}
			index += length;
		}
	}
	return null;
}
