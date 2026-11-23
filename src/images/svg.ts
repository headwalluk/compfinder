import { Resvg } from '@resvg/resvg-js';

/** The longest side of a rendered SVG, in pixels. */
export const SVG_MAX_SIDE_PX = 1200;
/** The width used when an SVG gives no size of its own. */
export const SVG_DEFAULT_WIDTH_PX = 256;
/** SVG input bigger than this isn't rendered. */
export const SVG_MAX_BYTES = 1024 * 1024;

/** An image that can't be used: too big, or an SVG that doesn't render. */
export class ImageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImageError';
  }
}

export interface RasterisedSvg {
  png: Buffer;
  width: number;
  height: number;
}

/** Renders an SVG logo to PNG. No external images or system fonts are loaded, so the result is the same on every host. */
export function rasteriseSvg(svg: Buffer): RasterisedSvg {
  if (svg.length > SVG_MAX_BYTES) {
    throw new ImageError(`SVG is larger than ${SVG_MAX_BYTES} bytes`);
  }
  let rasterised: RasterisedSvg;
  try {
    const probe = new Resvg(svg, { font: { loadSystemFonts: false } });
    const { width, height } = probe;
    const longest = Math.max(width, height);
    const fitTo = longest > SVG_MAX_SIDE_PX
      ? (width >= height ? { mode: 'width' as const, value: SVG_MAX_SIDE_PX } : { mode: 'height' as const, value: SVG_MAX_SIDE_PX })
      : (longest > 0 ? { mode: 'original' as const } : { mode: 'width' as const, value: SVG_DEFAULT_WIDTH_PX });
    const rendered = new Resvg(svg, { fitTo, font: { loadSystemFonts: false } }).render();
    rasterised = { png: rendered.asPng(), width: rendered.width, height: rendered.height };
  } catch (error) {
    throw new ImageError(`SVG didn't render: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return rasterised;
}
