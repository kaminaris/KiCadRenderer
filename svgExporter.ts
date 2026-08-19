import { Matrix3 } from './math/Matrix3';
import { Vec2 } from './math/Vec2';
import { Renderer, RenderStyle, EmbeddedImage } from './render/Renderer';
import { LayeredBoardScene } from './paint/BoardPainter';

interface SvgExporterOptions {
	background?: string;
	// When provided, wrap all world coords in a transform matching this
	// Matrix3. If omitted, world coords are emitted directly.
	viewMatrix?: Matrix3;
}

class SvgRenderer implements Renderer {
	private parts: string[] = [];
	private viewMatrix?: Matrix3;
	private opacity: number = 1;

	getSvgContent(): string {
		return this.parts.join('\n');
	}

	setViewMatrix(matrix: Matrix3): void {
		this.viewMatrix = matrix;
	}

	setOpacity(opacity: number): void {
		this.opacity = opacity;
	}

	beginBatch?(): void { /* no-op */ }
	endBatch?(): void { /* no-op */ }

	private applyPoint(p: Vec2): string {
		// Emit points as "x y" using the raw world coordinates; viewMatrix
		// will be applied externally as a wrapping group transform.
		return `${p.x} ${p.y}`;
	}

	private styleAttrs(style: RenderStyle): string {
		const attrs: string[] = [];
		if (style.fillColor) attrs.push(`fill=\"${style.fillColor}\"`);
		else attrs.push('fill=\"none\"');
		if (style.strokeColor) attrs.push(`stroke=\"${style.strokeColor}\"`);
		if (style.strokeWidth !== undefined) attrs.push(`stroke-width=\"${style.strokeWidth}\"`);
		if (style.capStyle) attrs.push(`stroke-linecap=\"${style.capStyle}\"`);
		if (this.opacity !== 1) attrs.push(`opacity=\"${this.opacity}\"`);
		return attrs.join(' ');
	}

	line(points: Vec2[], style: RenderStyle): void {
		if (points.length === 0) return;
		const d = points.map((p, i) => `${i===0 ? 'M' : 'L'} ${this.applyPoint(p)}`).join(' ');
		this.parts.push(`<path d=\"${d}\" ${this.styleAttrs(style)} fill=\"none\" />`);
	}

	polygon(points: Vec2[], style: RenderStyle): void {
		if (points.length === 0) return;
		const d = points.map((p, i) => `${i===0 ? 'M' : 'L'} ${this.applyPoint(p)}`).join(' ') + ' Z';
		this.parts.push(`<path d=\"${d}\" ${this.styleAttrs(style)} />`);
	}

	circle(center: Vec2, radius: number, style: RenderStyle): void {
		this.parts.push(`<circle cx=\"${center.x}\" cy=\"${center.y}\" r=\"${radius}\" ${this.styleAttrs(style)} />`);
	}

	arc(center: Vec2, radius: number, startAngleRad: number, endAngleRad: number, style: RenderStyle): void {
		// Approximate arc with an SVG arc path using the two endpoints.
		const x1 = center.x + Math.cos(startAngleRad) * radius;
		const y1 = center.y + Math.sin(startAngleRad) * radius;
		const x2 = center.x + Math.cos(endAngleRad) * radius;
		const y2 = center.y + Math.sin(endAngleRad) * radius;
		// large-arc-flag: 1 if angle > PI
		let delta = endAngleRad - startAngleRad;
		while (delta < 0) delta += Math.PI * 2;
		while (delta >= Math.PI * 2) delta -= Math.PI * 2;
		const largeArc = delta > Math.PI ? 1 : 0;
		const sweep = 1; // assume positive winding
		const d = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${x2} ${y2}`;
		this.parts.push(`<path d=\"${d}\" ${this.styleAttrs(style)} fill=\"none\" />`);
	}

	rect(topLeft: Vec2, width: number, height: number, style: RenderStyle): void {
		this.parts.push(`<rect x=\"${topLeft.x}\" y=\"${topLeft.y}\" width=\"${width}\" height=\"${height}\" ${this.styleAttrs(style)} />`);
	}

	image(image: EmbeddedImage, topLeft: Vec2, width: number, height: number, corners?: [Vec2, Vec2, Vec2, Vec2]): void {
		// Embedded images contain data; write as data URI if possible.
		const href = `data:${image.mimeType};base64,${image.data}`;
		this.parts.push(`<image x=\"${topLeft.x}\" y=\"${topLeft.y}\" width=\"${width}\" height=\"${height}\" href=\"${href}\" />`);
	}

	multiPolygon(rings: Vec2[][], style: RenderStyle): void {
		if (rings.length === 0) return;
		const d = rings.map(r => r.map((p, i) => `${i===0 ? 'M' : 'L'} ${this.applyPoint(p)}`).join(' ') + ' Z').join(' ');
		this.parts.push(`<path d=\"${d}\" ${this.styleAttrs(style)} fill-rule=\"evenodd\" />`);
	}

	flush?(): void { /* no-op */ }
	beginStaticBuild?(): void { /* no-op */ }
	endStaticBuild?(): void { /* no-op */ }
	beginDynamicFrame?(): void { /* no-op */ }
	flushOverlay?(): void { /* no-op */ }
}

export function sceneToSvg(scene: LayeredBoardScene, options: SvgExporterOptions = {}): string {
	const renderer = new SvgRenderer();
	// Let the painters' draw closures run and emit SVG primitives into our
	// renderer. Those closures will call renderer.* using world coordinates.
	for (const layer of scene.layersPresent) {
		const bucket = scene.layerBuckets.get(layer) ?? [];
		if (bucket.length === 0) continue;
		renderer.beginBatch?.();
		// Group per-layer for easier styling / inspection.
		renderer['parts'].push(`<g id=\"layer-${layer}\">`);
		for (const item of bucket) {
			try {
				item.draw(renderer as unknown as Renderer, 'black');
			} catch (err) {
				// Swallow individual draw errors to keep export resilient.
			}
		}
		renderer['parts'].push('</g>');
		renderer.endBatch?.();
	}

	const content = renderer.getSvgContent();
	const bg = options.background ? `<rect x=\"-10000\" y=\"-10000\" width=\"20000\" height=\"20000\" fill=\"${options.background}\" />\n` : '';
	// Matrix3 stores its 9 elements flat (see fromDOMMatrix's own layout):
	// [0]=a [1]=b [3]=c [4]=d [6]=e [7]=f, matching SVG's matrix(a b c d e f).
	const vm = options.viewMatrix?.elements;
	const viewGroup = vm ? `<g transform=\"matrix(${vm[0]} ${vm[1]} ${vm[3]} ${vm[4]} ${vm[6]} ${vm[7]})\">\n${content}\n</g>` : content;
	return `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\">\n${bg}${viewGroup}\n</svg>`;
}
