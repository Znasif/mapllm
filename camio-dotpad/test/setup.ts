import { afterEach } from 'vitest';

// The image tests are long, synchronous and back to back; yield one macrotask
// after each so the worker can answer Vitest's RPC (otherwise "Timeout calling
// onTaskUpdate" after a minute of uninterrupted CPU).
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
