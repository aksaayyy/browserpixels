/**
 * Client-side image compression using the native Canvas API.
 *
 * Design choice: this draws the decoded image onto a <canvas> and re-exports
 * it with canvas.toBlob(). That is the zero-dependency way to compress an
 * image in the browser — no npm libraries, no server, the file never leaves
 * the device. The quality slider maps to the `quality` argument of toBlob(),
 * which only affects lossy encodings (JPEG, WebP); PNG is lossless so the
 * slider does not change a PNG's size, and we surface that honestly in the
 * UI rather than pretending.
 *
 * The work is spread across async yields (createImageBitmap, a microtask
 * before the canvas draw, and the toBlob promise) so a 10–20MB image
 * produces one frame of work then hands control back, instead of freezing
 * the UI on one synchronous thread.
 */

export type CompressFormat = 'jpeg' | 'png' | 'webp';

export interface CompressOptions {
  /** 0–1 quality for lossy formats (JPEG/WebP). Ignored for PNG. */
  quality: number;
  /** Output format. Defaults to the input format. */
  format: CompressFormat;
}

export interface CompressResult {
  blob: Blob;
  outputUrl: string;
  format: CompressFormat;
  width: number;
  height: number;
  originalSize: number;
  compressedSize: number;
}

const MIME: Record<CompressFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function fileExtension(format: CompressFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/** Build the output filename for a compressed image, e.g. "photo.jpg" -> "photo-compressed.jpg". */
export function outputFileName(originalName: string, format: CompressFormat): string {
	return `${baseName(originalName)}-compressed.${fileExtension(format)}`;
}

/** Detect the supported output format from an input file's MIME/type. */
export function detectFormat(file: File): CompressFormat | null {
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
 * Compress a single image file. Throws on unsupported type or a decode
 * failure (malformed file the browser cannot rasterize).
 */
export async function compressImage(
	file: File,
	opts: CompressOptions
): Promise<CompressResult> {
	const format = opts.format;
	const mime = MIME[format];

	// clamp quality to [0,1] for the lossy encoders
	const q = Math.max(0, Math.min(1, opts.quality));

	// createImageBitmap decodes off the main render thread where available,
	// keeping a 20MB image from blocking the page during decode.
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		// Fallback path for very old browsers / odd files createImageBitmap
		// rejects on (e.g. some AVIF). Decode via an <img> instead — slower
		// but broadly supported.
		bitmap = await decodeViaImg(file);
	}

	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		bitmap.close?.();
		throw new Error('This browser cannot create a 2D canvas context.');
	}

	// For JPEG output we paint a white background first, because JPEG has no
	// alpha channel — a transparent PNG/WebP re-encoded as JPEG would otherwise
	// render its transparent pixels as solid black.
	if (format === 'jpeg') {
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
	}

	// Yield once before the draw so the browser can paint any pending UI
	// (e.g. the "compressing…" state) before the synchronous draw call.
	await new Promise((r) => setTimeout(r, 0));

	ctx.drawImage(bitmap, 0, 0);
	bitmap.close?.();

	const blob = await toBlobP(canvas, mime, format === 'png' ? undefined : q);
	if (!blob) {
		throw new Error('Compression failed — the browser could not encode the image.');
	}

	// Canvas→JPEG/WebP always re-encodes, so for tiny inputs the "compressed"
	// blob can occasionally be *larger* than the original. That is a real
	// outcome the UI must show, not something to hide.
	const outputUrl = URL.createObjectURL(blob);

	return {
		blob,
		outputUrl,
		format,
		width: canvas.width,
		height: canvas.height,
		originalSize: file.size,
		compressedSize: blob.size,
	};
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
