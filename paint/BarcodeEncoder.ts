/** Semantic barcode input as stored in a `.kicad_pcb` `(barcode ...)` node. */
export interface BoardBarcodeRequest {
	type: 'code39' | 'code128' | 'datamatrix' | 'qr' | 'microqr';
	text: string;
	errorCorrection: 'L' | 'M' | 'Q' | 'H';
}

/** Zint's vector output, normalized to its own local coordinate system. */
export interface BoardBarcodeEncoding {
	width: number;
	height: number;
	rectangles: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface BoardBarcodeEncoder {
	encode(request: BoardBarcodeRequest): BoardBarcodeEncoding;
}

let encoder: BoardBarcodeEncoder | null = null;
let loader: (() => Promise<BoardBarcodeEncoder>) | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Registers the app-owned, lazily loaded WASM implementation. The renderer
 * stays usable in non-browser consumers until a board actually needs it. */
export function registerBoardBarcodeEncoderLoader(nextLoader: () => Promise<BoardBarcodeEncoder>): void {
	loader = nextLoader;
}

export function onBoardBarcodeEncoderReady(listener: () => void): void {
	listeners.add(listener);
}

export function getBoardBarcodeEncoding(request: BoardBarcodeRequest): BoardBarcodeEncoding | null {
	if (encoder) {
		try {
			return encoder.encode(request);
		}
		catch (error) {
			console.warn('Unable to encode PCB barcode', error);
			return null;
		}
	}
	if (loader && !loading) {
		loading = loader()
			.then(nextEncoder => {
				encoder = nextEncoder;
				for (const listener of listeners) listener();
			})
			.catch(error => console.warn('Unable to load the Zint barcode encoder', error));
	}
	return null;
}

/** Loads the optional encoder on demand so editing UI can validate a draft
 * before it is committed to the board. */
export async function validateBoardBarcode(request: BoardBarcodeRequest): Promise<string | null> {
	if (!encoder && loader) {
		if (!loading) {
			loading = loader()
				.then(nextEncoder => {
					encoder = nextEncoder;
					for (const listener of listeners) listener();
				})
				.catch(error => {
					console.warn('Unable to load the Zint barcode encoder', error);
				});
		}
		await loading;
	}
	if (!encoder) return 'Barcode encoding is unavailable.';
	try {
		encoder.encode(request);
		return null;
	}
	catch {
		return 'This barcode type and error-correction level cannot encode the supplied text.';
	}
}
