// Shared-cell layouts for test/thread.ts, test/mainloop.ts and their thread.

import { cellLayout } from "../../src/thread.ts";

/** Eight words written together: a torn read shows up as two that differ. */
export const Hammer = cellLayout("hammer", { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0 });

/** A thread's own clock, as it last saw it. */
export const Ticker = cellLayout("ticker", { own: 0, at: 0 });

/** Written by the main thread, read by the thread. */
export const Setting = cellLayout("setting", { level: 0.5, on: false });
