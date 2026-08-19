/* Session state helpers: undo/redo stacks, batchDepth, and commit helpers.
 * Designed to be called from KicadRenderSession methods as a thin delegation
 * point so the session class becomes a thin orchestrator. Keep implementations
 * generic and accept `session: any` to avoid a circular type dependency.
 */

export function pushUndoSnapshot(session: any, label = 'Edit'): void {
	const text = session.documentType === 'schematic' ? session.getSchematicText() : session.getBoardText();
	if (!text || session.undoStack[session.undoStack.length - 1] === text) {
		return;
	}
	session.undoStack.push(text);
	session.undoLabels.push(label);
	// Enforce max depth if present on the class constructor
	const max = (session.constructor && (session.constructor as any).maxUndoDepth) || 100;
	if (session.undoStack.length > max) {
		session.undoStack.shift();
		session.undoLabels.shift();
	}
	// clear redo on a new edit
	session.redoStack.length = 0;
	session.redoLabels.length = 0;
}

export function clearUndoRedo(session: any): void {
	session.undoStack.length = 0;
	session.redoStack.length = 0;
	session.undoLabels.length = 0;
	session.redoLabels.length = 0;
}

export function canUndo(session: any): boolean {
	return session.undoStack && session.undoStack.length > 0;
}

export function canRedo(session: any): boolean {
	return session.redoStack && session.redoStack.length > 0;
}

export async function undo(session: any): Promise<boolean> {
	if (!canUndo(session)) return false;
	// Current live text goes to redo
	const current = session.documentType === 'schematic' ? session.getSchematicText() : session.getBoardText();
	const previous = session.undoStack.pop();
	const previousLabel = session.undoLabels.pop() ?? 'Edit';
	if (current !== undefined) {
		session.redoStack.push(current);
		session.redoLabels.push(previousLabel);
	}
	// Load previous text into session preserving view
	if (session.documentType === 'schematic') {
		await session.loadSchematicText(previous ?? '', { ...session.schematicDocInfo, preserveView: true });
	} else {
		await session.loadBoardText(previous ?? '', { preserveView: true });
	}
	return true;
}

export async function redo(session: any): Promise<boolean> {
	if (!canRedo(session)) return false;
	const current = session.documentType === 'schematic' ? session.getSchematicText() : session.getBoardText();
	const next = session.redoStack.pop();
	const nextLabel = session.redoLabels.pop() ?? 'Edit';
	if (current !== undefined) {
		session.undoStack.push(current);
		session.undoLabels.push(nextLabel);
	}
	if (session.documentType === 'schematic') {
		await session.loadSchematicText(next ?? '', { ...session.schematicDocInfo, preserveView: true });
	} else {
		await session.loadBoardText(next ?? '', { preserveView: true });
	}
	return true;
}

export async function cancelLatestUndoSnapshot(session: any): Promise<boolean> {
	if (!session.undoStack || session.undoStack.length === 0) return false;
	const isSchematic = session.documentType === 'schematic';
	const previous = session.undoStack.pop();
	session.undoLabels.pop();
	if (isSchematic) {
		await session.loadSchematicText(previous ?? '', { ...session.schematicDocInfo, preserveView: true });
	} else {
		await session.loadBoardText(previous ?? '', { preserveView: true });
	}
	return true;
}

export function getUndoStackDebug(session: any): { undoDepth: number; redoDepth: number; undo: { label: string; bytes: number }[] } {
	return {
		undoDepth: session.undoStack ? session.undoStack.length : 0,
		redoDepth: session.redoStack ? session.redoStack.length : 0,
		undo: (session.undoStack || []).map((text: string, index: number) => ({
			label: (session.undoLabels && session.undoLabels[index]) || 'Edit',
			bytes: text.length
		}))
	};
}

export function beginBatch(session: any): void {
	if (!session) return;
	if (typeof session.batchDepth !== 'number') session.batchDepth = 0;
	session.batchDepth++;
}

export function endBatch(session: any): void {
	if (!session) return;
	if (typeof session.batchDepth !== 'number') session.batchDepth = 0;
	if (session.batchDepth > 0) session.batchDepth--;
	if (session.batchDepth === 0) {
		// Commit any deferred rebuild
		if (typeof session.rebuildActiveScene === 'function') {
			session.rebuildActiveScene();
		}
	}
}

export function commitAstMutation(session: any): void {
	// If inside a batch, defer the rebuild to endBatch
	if (session.batchDepth > 0) return;
	if (typeof session.rebuildActiveScene === 'function') {
		session.rebuildActiveScene();
	}
}
