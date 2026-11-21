// One cap out of a tray photo (CAP-82; ADR-009 §1, §3; ADR-004 §1): the square around a detected circle, plus a 6 %
// margin, taken from the **full-resolution** photo, scaled to ≤ 1024 px and turned into the same `CapPhoto` as a single
// capture (images/resize.ts `crop: 'circle'`): dHash of the square inscribed in the circle, before the mask and before
// encoding; then the circular mask (transparent outside) and WebP through resize.ts `encodeWithin` (0.85, stepping
// down only above the upload limit).
// So a batch crop and a single capture of the same cap hash alike (same dHash contract).
//
// The square is kept inside the photo: for a cap at the edge it slides inwards (the circle is then off-centre; such
// caps come out of detection `uncertain` and the user checks them). Two inputs:
//   - `{ codec, image }`: the decoded photo, drawn by the codec (the canvas in the app);
//   - `{ raster, codec }`: RGBA pixels already in memory, resampled here by area averaging (tests, workers).
import { areaAverageGray, dhash } from '../images/dhash.js';
import {
  encodeWithin,
  fitWithin,
  inscribedSquare,
  maskCircle,
  WebpUnsupportedError,
  type CapPhoto,
  type Crop,
  type DecodedImage,
  type Raster,
  type RasterCodec,
} from '../images/resize.js';
import type { DetectedCircle } from './segment.js';

/** Margin around the circle, as a share of its radius (CAP-82). */
export const CROP_MARGIN = 0.06;

export type CropInput =
  | { readonly image: DecodedImage; readonly codec: RasterCodec }
  | { readonly raster: Raster; readonly codec: Pick<RasterCodec, 'encodeRaster'> };

/** The square (full-resolution pixels) around `circle` (detection pixels × `scale`), kept inside width × height. */
export function cropSquare(circle: DetectedCircle, scale: number, width: number, height: number): Crop {
  const side = Math.min(width, height, Math.max(1, Math.round(2 * circle.r * scale * (1 + CROP_MARGIN))));
  const clamp = (v: number, max: number) => Math.min(Math.max(0, v), max);
  const sx = clamp(Math.round(circle.cx * scale - side / 2), width - side);
  const sy = clamp(Math.round(circle.cy * scale - side / 2), height - side);
  return { sx, sy, sw: side, sh: side };
}

/** `crop` of `raster` resampled to width × height by area averaging (each RGBA channel). */
export function resampleRaster(raster: Raster, crop: Crop, width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  const region: Raster = {
    width: crop.sw,
    height: crop.sh,
    data: new Uint8ClampedArray(crop.sw * crop.sh * 4),
  };
  for (let y = 0; y < crop.sh; y++) {
    const from = ((crop.sy + y) * raster.width + crop.sx) * 4;
    region.data.set(raster.data.subarray(from, from + crop.sw * 4), y * crop.sw * 4);
  }
  // areaAverageGray works on luma; average each channel by feeding it as a gray image (R = G = B = channel).
  for (let c = 0; c < 4; c++) {
    const channel = new Uint8ClampedArray(crop.sw * crop.sh * 4);
    for (let i = 0; i < crop.sw * crop.sh; i++) {
      const v = region.data[i * 4 + c] ?? 0;
      channel[i * 4] = v;
      channel[i * 4 + 1] = v;
      channel[i * 4 + 2] = v;
    }
    const avg = areaAverageGray({ data: channel, width: crop.sw, height: crop.sh }, width, height);
    for (let i = 0; i < width * height; i++) data[i * 4 + c] = Math.round(avg[i] ?? 0);
  }
  return { data, width, height };
}

/** The `CapPhoto` of one detected circle (see the file comment). */
export async function cropCircle(input: CropInput, circle: DetectedCircle, scale: number): Promise<CapPhoto> {
  const full = 'image' in input ? input.image : input.raster;
  const crop = cropSquare(circle, scale, full.width, full.height);
  const { width, height } = fitWithin(crop.sw, crop.sh);
  const drawn =
    'image' in input
      ? await input.codec.raster(input.image, crop, width, height)
      : resampleRaster(input.raster, crop, width, height);
  if (drawn === null) throw new WebpUnsupportedError('this browser has no 2D canvas');
  const hash = dhash(inscribedSquare(drawn));
  const masked = maskCircle(drawn);
  // The same quality steps as a single capture (resize.ts, CAP-83 refactor).
  const blob = await encodeWithin((quality) => input.codec.encodeRaster(masked, quality));
  return { blob, width, height, dhash: hash };
}
