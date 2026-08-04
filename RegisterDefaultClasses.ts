// Wires the painters (BoardPainter/SchematicPainter) to @kicad-io's actual
// element classes — see BoardPainter.ts/SchematicPainter.ts's file-level
// comments for why this is a runtime registration step rather than a
// hard-coded import: the parser itself needs no setup (KicadParser's own
// internal nodeMap already produces correctly-typed instances for every
// tag), this registry only exists so the painters can pass concrete class
// references to findChildrenByClass()/instanceof checks.
//
// Pulled out of demo/main.ts into its own module so every consumer (the
// standalone demo AND the Angular viewer) calls the same registration code
// instead of maintaining two copies of this import list that could drift.
// Safe to call more than once (idempotent — just reassigns the same static
// class references).

import { KicadElementFootprint } from '@kicad-io/KicadElementFootprint';
import { KicadElementSegment }   from '@kicad-io/KicadElementStartEnd';
import { KicadElementVia }       from '@kicad-io/KicadElementVia';
import { KicadElementPad }       from '@kicad-io/KicadElementPad';
import { KicadElementZone }      from '@kicad-io/KicadElementZone';
import { KicadElementLayers }    from '@kicad-io/KicadElementLayers';
import { KicadElementGrLine, KicadElementGrRect, KicadElementFpLine, KicadElementFpRect } from '@kicad-io/KicadElementStartEnd';
import { KicadElementGrArc, KicadElementFpArc }     from '@kicad-io/KicadElementArc';
import { KicadElementGrCircle, KicadElementFpCircle }  from '@kicad-io/KicadElementCircle';
import { KicadElementDimension } from '@kicad-io/KicadElementDimension';
import { KicadElementGrText, KicadElementFpText, KicadElementText, KicadElementTextBox } from '@kicad-io/KicadElementText';

import { KicadElementWire }       from '@kicad-io/KicadElementWire';
import { KicadElementBus, KicadElementBusEntry }        from '@kicad-io/KicadElementBus';
import { KicadElementJunction }   from '@kicad-io/KicadElementJunction';
import { KicadElementNoConnect }  from '@kicad-io/KicadElementNoConnect';
import { KicadElementSymbol }     from '@kicad-io/KicadElementSymbol';
import { KicadElementLibSymbols } from '@kicad-io/KicadElementLibSymbols';
import { KicadElementGlobalLabel }       from '@kicad-io/KicadElementGlobalLabel';
import { KicadElementHierarchicalLabel } from '@kicad-io/KicadElementHierarchicalLabel';
import { KicadElementSheet } from '@kicad-io/KicadElementSheet';
import { KicadElementPin }   from '@kicad-io/KicadElementPin';
import { KicadElementNetclassFlag } from '@kicad-io/KicadElementNetclassFlag';
import { KicadElementRuleArea } from '@kicad-io/KicadElementRuleArea';
import { KicadElementTable } from '@kicad-io/KicadElementTable';
import { KicadElementImage } from '@kicad-io/KicadElementImage';
import { KicadElementRectangle } from '@kicad-io/KicadElementStartEnd';
import { KicadElementCircle as KicadElementSymCircle } from '@kicad-io/KicadElementCircle';
import { KicadElementArc as KicadElementSymArc }       from '@kicad-io/KicadElementArc';
import { KicadElementBezier, KicadElementPolyline } from '@kicad-io/KicadElementPolyline';
import { KicadElementAt }   from '@kicad-io/KicadElementAt';
import { KicadElementSize } from '@kicad-io/KicadElementSize';

import { BoardPainter, registerKicadIoClasses } from './paint/BoardPainter';
import { SchematicPainter, registerSchematicIoClasses } from './paint/SchematicPainter';

let registered = false;

export function registerDefaultKicadClasses(): void {
	if (registered) {
		return;
	}
	registered = true;

	registerKicadIoClasses({
		Footprint: KicadElementFootprint,
		Segment: KicadElementSegment,
		Via: KicadElementVia,
		Pad: KicadElementPad,
		Zone: KicadElementZone,
		Layers: KicadElementLayers,
		GrLine: KicadElementGrLine,
		GrArc: KicadElementGrArc,
		GrRect: KicadElementGrRect,
		GrCircle: KicadElementGrCircle,
		FpLine: KicadElementFpLine,
		FpRect: KicadElementFpRect,
		FpCircle: KicadElementFpCircle,
		FpArc: KicadElementFpArc,
		Dimension: KicadElementDimension,
		GrText: KicadElementGrText,
		FpText: KicadElementFpText,
	});

	registerSchematicIoClasses({
		Wire: KicadElementWire,
		Bus: KicadElementBus,
		BusEntry: KicadElementBusEntry,
		Junction: KicadElementJunction,
		NoConnect: KicadElementNoConnect,
		Symbol: KicadElementSymbol,
		LibSymbols: KicadElementLibSymbols,
		GlobalLabel: KicadElementGlobalLabel,
		HierLabel: KicadElementHierarchicalLabel,
		Sheet: KicadElementSheet,
		Pin: KicadElementPin,
		NetclassFlag: KicadElementNetclassFlag,
		RuleArea: KicadElementRuleArea,
		Table: KicadElementTable,
		Image: KicadElementImage,
		Rect: KicadElementRectangle,
		SymCircle: KicadElementSymCircle,
		SymArc: KicadElementSymArc,
		Polyline: KicadElementPolyline,
		Bezier: KicadElementBezier,
		At: KicadElementAt,
		Size: KicadElementSize,
		Text: KicadElementText,
		TextBox: KicadElementTextBox,
	});
}

// Re-exported so callers that only need the painter classes (not the
// registration side-effect directly) can import both from one module.
export { BoardPainter, SchematicPainter };
export type { BoardPaintOptions } from './paint/BoardPainter';
