# KiCadRenderer

Pure TypeScript schematic / PCB renderer for KiCad files. No build step — consumers import the `.ts` sources directly and provide TypeScript path aliases.

## Attribution

Parts of this library are derived from [KiCanvas](https://github.com/theacodes/kicanvas) by Alethea Katherine Flowers, used under the MIT License. See [KiCanvas `LICENSE.md`](https://github.com/theacodes/kicanvas/blob/main/LICENSE.md) for the full text and third-party notices.

### Ported from KiCanvas

These modules started as ports of KiCanvas sources (renamed to this project's camelCase / PascalCase conventions, and trimmed where we only needed a subset):

| This package | Origin (KiCanvas) |
|---|---|
| `math/Angle.ts`, `Vec2.ts`, `BBox.ts`, `Matrix3.ts`, `Camera2.ts` | `src/base/math/` |
| `text/Glyph.ts`, `StrokeGlyph.ts`, `StrokeFont.ts` | `src/kicad/text/` stroke font |
| `text/NewstrokeGlyphs.ts` | Newstroke glyph tables bundled by KiCanvas |
| `paint/StrokeDash.ts` | dashed-stroke helpers from the base painter |
| `paint/KicadStringEscapes.ts` | `unescape_string` in `src/kicad/common.ts` |
| Drawing-sheet / pin / label geometry helpers in the painters | corresponding KiCanvas schematic/board painters |

Painters, render backends, and `KicadRenderSession` are largely original to this project, but they follow KiCad (and often KiCanvas) behavior when matching real file output.

### Newstroke font

`text/NewstrokeGlyphs.ts` is the Newstroke stroke font data as packaged for KiCanvas. Per [KiCanvas's license notice](https://github.com/theacodes/kicanvas/blob/main/LICENSE.md):

> Newstroke by Vladimir Uryvaev, Lingdong Huang, Adobe, and KiCad contributors. Originally licensed under Creative Commons CC0 1.0, amended with an MIT-like license, and utilizes glyphs that are licensed under the SIL Open Font License Version 1.1.

## Peer dependency

Requires [KiCadParser](https://github.com/kaminaris/KiCadParser) (`kicad-io`) for parsing and element classes.

This package imports it as `@kicad-io/...` (never via relative sibling paths).

## Consumer setup

Point both packages at sibling checkout paths (for example git submodules) and add aliases in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@kicad-io/*": ["../shared/kicad-io/src/*"],
      "@kicad-render/*": ["../shared/kicad-render/*"]
    }
  }
}
```

Include the sources in your app compile set (example for Angular):

```json
{
  "include": [
    "src/**/*.ts",
    "../shared/kicad-render/**/*.ts",
    "../shared/kicad-io/src/**/*.ts"
  ]
}
```

## Usage

Deep import (tree-friendly):

```ts
import { KicadRenderSession } from '@kicad-render/KicadRenderSession';

const session = new KicadRenderSession(canvas2d, canvasGl);
await session.loadSchematicText(schText);
```

Or the barrel:

```ts
import { KicadRenderSession, BoardPainter, hitTest } from '@kicad-render/index';
```

`KicadRenderSession` is framework-agnostic: your UI owns the canvas DOM and pointer/wheel wiring.

## Naming

- Identifiers are **camelCase** (no underscores), including constants.
- One class per file; file names match the class in **PascalCase** (`Vec2.ts`, `StrokeGlyph.ts`, …).
- KiCad protocol strings (`dash_dot`, `pin_names`, drawing-sheet vars like `ISSUE_DATE`) keep their upstream spelling.

## Extending

This library is meant to be subclassed. Class fields and helpers use TypeScript `protected` (not `private` / `#field`) so consumers can override painters, backends, and the session without fighting encapsulation.

Typical extension points:

- **`KicadRenderSession`** — swap painters, change fit/grid/selection behavior
- **`BoardPainter` / `SchematicPainter`** — override `build*` helpers for custom element drawing
- **`Canvas2dRenderer` / `WebGLRenderer`** — alternate backends behind the shared `Renderer` interface
- **`hitTest` / `PaintedShape`** — custom picking against the painted scene

Prefer `protected` overrides over forking files when you only need a few drawing differences.
