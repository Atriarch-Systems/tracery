/**
 * `ActivityGraph.toImage` (docs/SHARING.md "Image export"): renders the
 * live canvas at its current view onto an offscreen canvas, scaled up, with
 * an optional small "Tracery Graph" mark in the accent colour. The actual pixel
 * work (`renderCapture`) is a pure function over a minimal canvas-like
 * interface so it is unit-testable in plain Node with a fake canvas/context
 * -- no real rendering, no DOM -- while `ActivityGraph.tsx` supplies the
 * real `document.createElement('canvas')` and the force-graph's own canvas
 * element as `source`.
 */

/** The subset of `CanvasRenderingContext2D` this module actually calls. */
export interface CaptureContextLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign | string;
  textBaseline: CanvasTextBaseline | string;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
  fillText(text: string, x: number, y: number): void;
}

/** The subset of `HTMLCanvasElement` this module actually calls. */
export interface CaptureCanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): CaptureContextLike | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface CaptureSourceLike {
  readonly width: number;
  readonly height: number;
}

export interface CaptureOptions {
  /** Resolution multiplier for the output canvas relative to `source`. Default 2. */
  readonly scale?: number;
  /** Painted behind the captured frame before `drawImage`, since the live canvas itself is transparent (`ActivityGraph`'s `backgroundColor="rgba(0,0,0,0)"`). Omit for a transparent PNG. */
  readonly background?: string;
  /** Draws the small "Tracery Graph" mark in the bottom-right corner, in the accent colour. Default true. */
  readonly mark?: boolean;
}

export const TRACERY_MARK_TEXT = 'Tracery Graph';
/** `--tracery-accent`'s default (packages/react/src/style.ts's `DEFAULTS.accent`) -- kept as a plain literal here since this package has no dependency on `@atriarch-systems/tracery-react`. */
export const TRACERY_MARK_COLOR = '#7c9cff';
const MARK_MARGIN_PX = 10;
const MARK_FONT_PX = 12;

/**
 * Draws `source` onto a fresh canvas built by `createCanvas(width, height)`,
 * scaled by `options.scale`, with an optional background fill and mark.
 * Never touches `document` itself -- `createCanvas` is the only seam that
 * needs a real DOM, so a test can pass a fake one.
 */
export function renderCapture(source: CaptureSourceLike, createCanvas: (width: number, height: number) => CaptureCanvasLike, options: CaptureOptions = {}): CaptureCanvasLike {
  const scale = options.scale ?? 2;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('renderCapture: 2D canvas context unavailable');

  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.drawImage(source, 0, 0, width, height);

  if (options.mark ?? true) {
    const fontSize = Math.max(10, Math.round(MARK_FONT_PX * scale));
    ctx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = TRACERY_MARK_COLOR;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const margin = MARK_MARGIN_PX * scale;
    ctx.fillText(TRACERY_MARK_TEXT, width - margin, height - margin);
  }

  return canvas;
}

/** `HTMLCanvasElement.toBlob` as a Promise, PNG by default. */
export function captureToBlob(canvas: CaptureCanvasLike, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('captureToBlob: toBlob produced no blob'))), type);
  });
}
