// Client-side image preparation before upload (ADR-006: WebP, long edge ≤ 1024 px; CAP-25): decode the picked photo,
// optionally crop it to a centred square (off by default — the circular crop is V2), scale the long edge down to
// 1024 px and encode WebP at quality 0.85 on a canvas. A browser that cannot encode WebP gets an error, never a JPEG
// named `.webp` (story CAP-25 § How). The decoder/encoder sit behind `ImageCodec` so tests run without a real canvas.

/** Long edge of every stored image (ADR-006, shared `ImageRef` max). */
export const MAX_EDGE = 1024;
/** Encoder quality (story CAP-25). */
export const WEBP_QUALITY = 0.85;
/** `POST /uploads` accepts up to 1 MiB (shared `UploadRequest.bytes`). */
export const MAX_BYTES = 1_048_576;
/** Lower qualities tried, in order, when a 0.85 encode is still above MAX_BYTES. */
const FALLBACK_QUALITIES = [0.7, 0.55];

export const WEBP = 'image/webp';

/** The browser encoded something other than WebP (canvas falls back to PNG silently). */
export class WebpUnsupportedError extends Error {
  override readonly name = 'WebpUnsupportedError';
}

/** The picked file is not an image the browser can decode. */
export class ImageDecodeError extends Error {
  override readonly name = 'ImageDecodeError';
}

/** Even at the lowest quality the WebP is larger than the upload limit. */
export class ImageTooLargeError extends Error {
  override readonly name = 'ImageTooLargeError';
}

export interface DecodedImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  /** Frees the decoded bitmap, when the decoder holds one. */
  close?(): void;
}

/** Region of the source copied into the output. */
export interface Crop {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

export interface ImageCodec {
  decode(file: Blob): Promise<DecodedImage>;
  /** Draw `crop` of `image` at `width` × `height` and encode it; null when the canvas yields no blob. */
  encode(image: DecodedImage, crop: Crop, width: number, height: number, quality: number): Promise<Blob | null>;
}

export interface ResizedImage {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

export interface ResizeOptions {
  /** Centre-crop to a square first. Default false. */
  readonly square?: boolean;
  readonly codec?: ImageCodec;
}

/** Output size: the long edge scaled down to `max` (never up), aspect ratio kept, at least 1 px each way. */
export function fitWithin(width: number, height: number, max = MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The whole image, or its centred square when `square` is set. */
export function cropFor(width: number, height: number, square: boolean): Crop {
  if (!square) return { sx: 0, sy: 0, sw: width, sh: height };
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), sw: side, sh: side };
}

export async function resizeToWebp(file: Blob, options: ResizeOptions = {}): Promise<ResizedImage> {
  const codec = options.codec ?? browserCodec();
  const image = await codec.decode(file);
  try {
    const crop = cropFor(image.width, image.height, options.square ?? false);
    const { width, height } = fitWithin(crop.sw, crop.sh);
    for (const quality of [WEBP_QUALITY, ...FALLBACK_QUALITIES]) {
      const blob = await codec.encode(image, crop, width, height, quality);
      if (blob === null || blob.type !== WEBP) throw new WebpUnsupportedError('this browser cannot encode WebP');
      if (blob.size <= MAX_BYTES) return { blob, width, height };
    }
    throw new ImageTooLargeError(`WebP above ${MAX_BYTES} bytes`);
  } finally {
    image.close?.();
  }
}

export interface BrowserCodecDeps {
  readonly document?: Document;
  /** `createImageBitmap` when the browser has it (all current ones); otherwise an <img> decodes the file. */
  readonly createImageBitmap?: ((blob: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>) | undefined;
  readonly URL?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}

/** Canvas-based codec of the running browser / WKWebView (Safari ≥ 16 encodes WebP). */
export function browserCodec(deps: BrowserCodecDeps = {}): ImageCodec {
  const doc = deps.document ?? document;
  const bitmap =
    'createImageBitmap' in deps
      ? deps.createImageBitmap
      : typeof createImageBitmap === 'function'
        ? createImageBitmap
        : undefined;
  const urls = deps.URL ?? URL;

  async function decodeWithImg(file: Blob): Promise<DecodedImage> {
    const url = urls.createObjectURL(file);
    try {
      const img = doc.createElement('img');
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new ImageDecodeError('image could not be decoded'));
        img.src = url;
      });
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      urls.revokeObjectURL(url);
    }
  }

  return {
    async decode(file) {
      if (bitmap === undefined) return decodeWithImg(file);
      let decoded: ImageBitmap;
      try {
        // `from-image` applies the EXIF orientation of iPhone photos.
        decoded = await bitmap(file, { imageOrientation: 'from-image' });
      } catch (error) {
        throw new ImageDecodeError('image could not be decoded', { cause: error });
      }
      return { source: decoded, width: decoded.width, height: decoded.height, close: () => decoded.close() };
    },
    encode(image, crop, width, height, quality) {
      const canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (g === null) return Promise.resolve(null);
      g.imageSmoothingQuality = 'high';
      g.drawImage(image.source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
      return new Promise((resolve) => canvas.toBlob(resolve, WEBP, quality));
    },
  };
}
