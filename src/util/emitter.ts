/** Minimal event emitter so engine code stays independent of the `vscode` module. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A faulty listener must not break the emitter.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
