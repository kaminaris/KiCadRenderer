# KiCadRenderer

Pure TypeScript schematic / PCB renderer for KiCad files. No build step — consumers import the `.ts` sources directly and provide TypeScript path aliases.

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
