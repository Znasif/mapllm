/** A minimal typed event emitter (no dependencies). */
export class Emitter<Events extends { [K in keyof Events]: unknown }> {
	private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

	/** Subscribe; returns an unsubscribe function. */
	on<K extends keyof Events>(type: K, listener: (payload: Events[K]) => void): () => void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener as (payload: never) => void);
		return () => this.off(type, listener);
	}

	off<K extends keyof Events>(type: K, listener: (payload: Events[K]) => void): void {
		this.listeners.get(type)?.delete(listener as (payload: never) => void);
	}

	emit<K extends keyof Events>(type: K, payload: Events[K]): void {
		const set = this.listeners.get(type);
		if (!set) return;
		for (const l of [...set]) {
			try {
				(l as (p: Events[K]) => void)(payload);
			} catch (error) {
				// A host listener must never break the frame loop.
				console.error(`[CamioDotPad] '${String(type)}' listener failed:`, error);
			}
		}
	}

	clear(): void {
		this.listeners.clear();
	}
}
