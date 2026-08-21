let encoder = null;
let loader = null;
let loading = null;
const listeners = new Set();
/** Registers the app-owned, lazily loaded WASM implementation. The renderer
 * stays usable in non-browser consumers until a board actually needs it. */
export function registerBoardBarcodeEncoderLoader(nextLoader) {
    loader = nextLoader;
}
export function onBoardBarcodeEncoderReady(listener) {
    listeners.add(listener);
}
export function getBoardBarcodeEncoding(request) {
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
            for (const listener of listeners)
                listener();
        })
            .catch(error => console.warn('Unable to load the Zint barcode encoder', error));
    }
    return null;
}
/** Loads the optional encoder on demand so editing UI can validate a draft
 * before it is committed to the board. */
export async function validateBoardBarcode(request) {
    if (!encoder && loader) {
        if (!loading) {
            loading = loader()
                .then(nextEncoder => {
                encoder = nextEncoder;
                for (const listener of listeners)
                    listener();
            })
                .catch(error => {
                console.warn('Unable to load the Zint barcode encoder', error);
            });
        }
        await loading;
    }
    if (!encoder)
        return 'Barcode encoding is unavailable.';
    try {
        encoder.encode(request);
        return null;
    }
    catch {
        return 'This barcode type and error-correction level cannot encode the supplied text.';
    }
}
