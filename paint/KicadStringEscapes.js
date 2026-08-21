// KiCad escapes a handful of characters that would otherwise collide with
// its own S-expression/markup syntax (quotes, braces, the variable-reference
// `{...}` delimiters themselves, etc.) as `{name}` tokens wherever they
// appear in free text — not just inside drawing-sheet `${VAR}` text, but in
// ANY text value: label names, symbol/schematic text, property values.
// Confirmed via a real global label whose name contained a literal `/`,
// stored in the file as `I2C2 SDA{slash}USART3 RX` — rendering the raw
// stored string verbatim (this renderer's behavior before this fix) shows
// the literal escape token instead of the character it represents. Ports
// kicanvas's unescape_string() (src/kicad/common.ts).
const kicadStringEscapes = {
    dblquote: '"', quote: '\'', lt: '<', gt: '>', backslash: '\\', slash: '/',
    bar: '|', comma: ',', colon: ':', space: ' ', dollar: '$', tab: '\t',
    return: '\n', brace: '{',
};
export function unescapeKicadString(str) {
    let result = str;
    for (const [name, char] of Object.entries(kicadStringEscapes)) {
        result = result.split(`{${name}}`).join(char);
    }
    return result;
}
