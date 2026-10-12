export type Clock = {
  now(): number;
  setTimeout(fn: () => unknown, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(() => void fn(), ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};
