/**
 * Client-side image resizing using the native Canvas API.
 *
 * Design choice: this decodes the image and draws it onto a <canvas> sized to
 * the requested dimensions, then re-exports with canvas.toBlob(). That is the
 * zero-dependency way to resize an image in the browser — no npm libraries, no
 * server, the file never leaves the device. It mirrors the compressor's
 * approach so behavior stays consistent across the tool suite.
 *
 * Two sizing modes are supported:
 *   - Exact dimensions (width/height, optionally maintaining aspect ratio).
 *   - Percentage scale (e.g. 50% of the original pixel dimensions).
 *
 * The format is preserved from the input by default to avoid accidental
 * recompression surprises (a JPEG stays a JPEG at the browser's default
 * quality), though the canvas encoder re-encodes regardless — resizing always
 * re-renders the pixels, so this is inherent to any resize operation.
 *
 * The work is spread across async yields (createImageBitmap, a microtask
 * before the canvas draw, and the toBlob promise) so a large image produces
 * one frame of work then hands control back, instead of freezing the UI.
 */

export type ResizeFormat = 'jpeg' | 'png' | 'webp';

export type ResizeMode = 'dimensions' | 'percent';

export interface ResizeOptions {
  mode: ResizeMode;
  /** Target width in px (used in dimensions mode; required when mode = 'dimensions'). */
  width?: number;
  /** Target height in px (used in dimensions mode; required when mode = 'dimensions'). */
  height?: number;
  /** When true (dimensions mode), keep aspect ratio of the source for whichever dim is set. */
  maintainAspect?: boolean;
  /** 1–100 percent scale (used in percent mode). */
  percent?: number;
  /** Output format. Defaults to the input format. */
  format?: ResizeFormat;
  /** 0–1 quality for lossy formats (JPEG/WebP). Ignored for PNG. Defaults to 0.92. */
  quality?: number;
}

export interface ResizeResult {
  blob: Blob;
  outputUrl: string;
  format: ResizeFormat;
  /** Original pixel dimensions of the decoded source. */
  originalWidth: number;
  originalHeight: number;
  /** Resulting canvas dimensions. */
  width: number;
  height: number;
  originalSize: number;
  resizedSize: number;
}

const MIME: Record<ResizeFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function fileExtension(format: ResizeFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Build the output filename for a resized image, e.g. "photo.jpg" -> "photo-800x600.jpg". */
export function outputFileName(
  originalName: string,
  format: ResizeFormat,
  width: number,
  height: number
): string {
  return `${baseName(originalName)}-${width}x${height}.${fileExtension(format)}`;
}

/** Detect the supported format from an input file's MIME/type. */
export function detectFormat(file: File): ResizeFormat | null {
  const t = file.type.toLowerCase();
  if (t === 'image/jpeg' || t === 'image/jpg') return 'jpeg';
  if (t === 'image/png') return 'png';
  if (t === 'image/webp') return 'webp';
  // Fall back to extension sniffing — some browsers give an empty MIME for HEIC etc.
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'jfif') return 'jpeg';
  if (ext === 'png') return 'png';
  if (ext === 'webp') return 'webp';
  return null;
}

export const ACCEPTED = '.jpg,.jpeg,.png,.webp';

/**
 * Compute the canvas dimensions an image of size `srcW` x `srcH` should be
 * drawn to, given the options. Centralizes the aspect-ratio math so the UI and
 * the encode path can't disagree about the target size.
 */
export function computeTargetSize(
  srcW: number,
  srcH: number,
  opts: ResizeOptions
): { width: number; height: number } {
  if (opts.mode === 'percent') {
    const pct = clampPercent(opts.percent ?? 100) / 100;
    return {
      width: Math.max(1, Math.round(srcW * pct)),
      height: Math.max(1, Math.round(srcH * pct)),
    };
  }

  // dimensions mode
  const aspect = srcW / srcH;
  let width = Math.max(1, Math.round(opts.width ?? 0));
  let height = Math.max(1, Math.round(opts.height ?? 0));

  if (opts.maintainAspect) {
    // If only one dimension is meaningfully set, derive the other from aspect.
    const hasW = (opts.width ?? 0) > 0;
    const hasH = (opts.height ?? 0) > 0;
    if (hasW && !hasH) {
      height = Math.max(1, Math.round(width / aspect));
    } else if (hasH && !hasW) {
      width = Math.max(1, Math.round(height * aspect));
    } else if (hasW && hasH) {
      // Both provided with aspect lock: keep width, derive height (width wins).
      height = Math.max(1, Math.round(width / aspect));
    } else {
      // Neither provided — just keep the original size.
      width = srcW;
      height = srcH;
    }
  }

  return { width, height };
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 100;
  return Math.max(1, Math.min(200, Math.round(p)));
}

function toBlobP(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    // quality is ignored by the PNG encoder; passing it is harmless.
    canvas.toBlob(
      (blob) => resolve(blob),
      type,
      quality
    );
  });
}

/**
 * Resize a single image file. Throws on unsupported type, a decode failure, or
 * an invalid target size (e.g. both dimensions empty with aspect unlocked).
 */
export async function resizeImage(
  file: File,
  opts: ResizeOptions
): Promise<ResizeResult> {
  const inputFmt = detectFormat(file);
  if (!inputFmt) {
    throw new Error('Unsupported type — use JPG, PNG, or WebP.');
  }
  const format = opts.format ?? inputFmt;
  const mime = MIME[format];

  // createImageBitmap decodes off the main render thread where available,
  // keeping a large image from blocking the page during decode.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Fallback path for very old browsers / odd files createImageBitmap
    // rejects on (e.g. some AVIF). Decode via an <img> instead — slower
    // but broadly supported.
    bitmap = await decodeViaImg(file);
  }

  const srcW = bitmap.width;
  const srcH = bitmap.height;
  if (srcW < 1 || srcH < 1) {
    bitmap.close?.();
    throw new Error('This image has no decodable pixel dimensions.');
  }

  const { width: targetW, height: targetH } = computeTargetSize(srcW, srcH, opts);
  if (targetW < 1 || targetH < 1) {
    bitmap.close?.();
    throw new Error('Enter a target width and height (or switch to percentage scale).');
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close?.();
    throw new Error('This browser cannot create a 2D canvas context.');
  }

  // Smooth scaling for downsize quality. Image smoothing is on by default but
  // set explicitly so the behavior is deterministic across browsers.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // For JPEG output we paint a white background first, because JPEG has no
  // alpha channel — a transparent PNG/WebP re-encoded as JPEG would otherwise
  // render its transparent pixels as solid black.
  if (format === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Yield once before the draw so the browser can paint any pending UI
  // (e.g. the "resizing…" state) before the synchronous draw call.
  await new Promise((r) => setTimeout(r, 0));

  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const q = Math.max(0, Math.min(1, opts.quality ?? 0.92));
  const blob = await toBlobP(canvas, mime, format === 'png' ? undefined : q);
  if (!blob) {
    throw new Error('Resize failed — the browser could not encode the image.');
  }

  const outputUrl = URL.createObjectURL(blob);

  return {
    blob,
    outputUrl,
    format,
    originalWidth: srcW,
    originalHeight: srcH,
    width: canvas.width,
    height: canvas.height,
    originalSize: file.size,
    resizedSize: blob.size,
  };
}

/**
 * Decode just enough of a file to read its natural pixel dimensions, without
 * running the full resize pipeline. Used by the UI to show the original size
 * and seed the width/height inputs as soon as a user picks a file.
 */
export function readDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      URL.revokeObjectURL(url);
      if (w >= 1 && h >= 1) resolve({ width: w, height: h });
      else reject(new Error('This image has no decodable pixel dimensions.'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This file could not be decoded as an image.'));
    };
    img.src = url;
  });
}

function decodeViaImg(file: File): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      try {
        const bmp = await createImageBitmap(img);
        URL.revokeObjectURL(url);
        resolve(bmp);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This file could not be decoded as an image.'));
    };
    img.src = url;
  });
}
