/*
 * Ported from KiCad source:
 *   pcbnew/board_stackup_manager.h
 *   pcbnew/board_stackup_manager.cpp (subset)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The layer stackup: the ordered list of copper, dielectric and surface-finish
 * layers with their thickness — used for impedance / 3D / DRC. Dimensions in
 * mm.
 */

/** Mirrors BOARD_STACKUP_ITEM's type. */
export enum StackupType {
	DISABLED = 0,
	COPPER = 1,
	DIELECTRIC = 4,
	SURFACE_FINISH = 5,
	TECHNICAL = 8,
}

/**
 * One stackup layer. Mirrors KiCad's BOARD_STACKUP_ITEM.
 */
export class STACKUP_ITEM {
	type: StackupType = StackupType.DISABLED;
	name = '';
	thickness = 0; // mm
	// Vertical position (mm from the top of the stackup).
	position = 0;
	// For dielectrics: the dielectric constant / tolerance (strings, KiCad).
	dK = '';
	dTolerance = '';
	dLayer = 0;

	constructor(aType: StackupType = StackupType.DISABLED, aName = '', aThickness = 0) {
		this.type = aType;
		this.name = aName;
		this.thickness = aThickness;
	}

	GetTypeName(): string {
		switch (this.type) {
			case StackupType.COPPER:
				return 'copper';
			case StackupType.DIELECTRIC:
				return 'dielectric';
			case StackupType.SURFACE_FINISH:
				return 'surfacefinish';
			case StackupType.TECHNICAL:
				return 'technical';
			case StackupType.DISABLED:
			default:
				return 'disabled';
		}
	}

	IsCopperLayer(): boolean {
		return this.type === StackupType.COPPER;
	}

	IsDielectricLayer(): boolean {
		return this.type === StackupType.DIELECTRIC;
	}
}

/**
 * The board stackup. Mirrors KiCad's BOARD_STACKUP_MANAGER: a list of
 * STACKUP_ITEM (copper, dielectric, surface finish) plus the copper layer
 * count.
 */
export class BOARD_STACKUP {
	private m_layers: STACKUP_ITEM[] = [];
	private m_copperLayers = 2;

	/** Builds a default stackup for the given number of copper layers. */
	BuildFromCopperCount(aCopperCount: number): void {
		this.m_layers = [];
		this.m_copperLayers = Math.min(32, Math.max(2, aCopperCount));

		const copperPerSide = Math.min(2, this.m_copperLayers);
		const internalCount = Math.max(0, this.m_copperLayers - 2);

		let pos = 0;
		// Top surface finish.
		const top = new STACKUP_ITEM(StackupType.SURFACE_FINISH, 'Top finish', 0.01);
		top.position = pos;
		this.m_layers.push(top);
		pos += top.thickness;

		// Top copper (outer).
		const topCu = new STACKUP_ITEM(StackupType.COPPER, 'Top outer', 0.035);
		topCu.position = pos;
		this.m_layers.push(topCu);
		pos += topCu.thickness;

		for (let i = 0; i < internalCount; i++) {
			const diel = new STACKUP_ITEM(StackupType.DIELECTRIC, `Pre-preg ${ i + 1 }`, 0.13);
			diel.position = pos;
			this.m_layers.push(diel);
			pos += diel.thickness;

			const inner = new STACKUP_ITEM(StackupType.COPPER, `In${ i + 1 }.Cu`, 0.035);
			inner.position = pos;
			this.m_layers.push(inner);
			pos += inner.thickness;
		}

		// Bottom copper + finish.
		const botCu = new STACKUP_ITEM(StackupType.COPPER, 'Bottom outer', 0.035);
		botCu.position = pos;
		this.m_layers.push(botCu);
		pos += botCu.thickness;

		const bot = new STACKUP_ITEM(StackupType.SURFACE_FINISH, 'Bottom finish', 0.01);
		bot.position = pos;
		this.m_layers.push(bot);
		pos += bot.thickness;
	}

	Layers(): STACKUP_ITEM[] {
		return this.m_layers;
	}

	AddLayer(aLayer: STACKUP_ITEM): void {
		this.m_layers.push(aLayer);
	}

	GetCopperLayerCount(): number {
		return this.m_copperLayers;
	}

	/** Total board thickness (sum of all layers). */
	GetBoardThickness(): number {
		let t = 0;
		for (const l of this.m_layers) {
			t += l.thickness;
		}
		return t;
	}

	/** The copper layers in the stackup (in stackup order). */
	CopperLayers(): STACKUP_ITEM[] {
		return this.m_layers.filter(l => l.IsCopperLayer());
	}
}
