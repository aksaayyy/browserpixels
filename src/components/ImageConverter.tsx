import { useCallback, useRef, useState } from 'react';
import JSZip from 'jszip';
// heic2any references `window` at module top level, so we dynamic-import it
// on the client only — statically importing it breaks Astro's SSR pre-render.

type FileStatus = 'pending' | 'converting' | 'done' | 'error';

interface ConvertedImage {
  id: string;
  originalName: string;
  outputName: string;
  status: FileStatus;
  errorMessage?: string;
  blob?: Blob; // the converted JPEG blob
  outputUrl?: string; // object URL for download
  originalSize: number;
  outputSize: number;
  progress: number; // 0..100
  oversized?: boolean; // large HEIC — decode may be heavy on low-memory devices
}

const ACCEPTED = '.heic,.heif,.webp,.jpg,.jpeg,.png';
const JPEG_QUALITY = 0.9;

/* --- Soft memory guards for in-browser HEIC decode -----------------------------
 * heic2any decodes HEIC via WebAssembly fully in memory, so peak RAM for one
 * image can run to several hundred MB before the JPG is emitted. Browsers don't
 * surface memory pressure from WASM — on older iPhones and low-memory devices a
 * large batch can exhaust the tab's memory limit and force a reload. We can't
 * know the device's ceiling, so instead of silently risking a crash we soften
 * the risk with informed prompts. These are deliberately conservative so the
 * tool keeps working for normal use (a handful of photos) without nagging.
 */
const HEIC_BATCH_WARN_COUNT = 15; // prompt above this many HEIC files in one drop
const HEIC_BATCH_WARN_BYTES = 150 * 1024 * 1024; // ~150 MB combined HEIC in one drop
const HEIC_SINGLE_WARN_BYTES = 8 * 1024 * 1024; // ~8 MB ≈ a full-res iPhone photo

/** Heuristically detect HEIC/HEIF regardless of the file extension browsers report. */
function isHeic(file: File): boolean {
  const ext = file.name.toLowerCase();
  return ext.endsWith('.heic') || ext.endsWith('.heif');
}

function isWebp(file: File): boolean {
  return (
    file.type === 'image/webp' ||
    file.name.toLowerCase().endsWith('.webp')
  );
}

function makeId(): string {
  // Avoid Math.random — use a monotonic-ish counter + timestamp.
  return `${Date.now().toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}`;
}

/** Convert any image the browser can decode to a JPEG blob via canvas. */
function canvasToJpeg(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }
        // White background so transparent PNG/WebP don't go black as JPEG.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url);
            if (blob) resolve(blob);
            else reject(new Error('Canvas toBlob returned null'));
          },
          'image/jpeg',
          JPEG_QUALITY
        );
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Browser could not decode the image'));
    };

    img.src = url;
  });
}

/** Pass-through for already-supported JPG. PNG → JPEG via canvas. */
async function convertImage(file: File): Promise<Blob> {
  if (isHeic(file)) {
    // Lazy-load heic2any so it never touches the server / build.
    const { default: heic2any } = await import('heic2any');
    // heic2any returns Blob | Blob[]; we always ask for a single blob.
    const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: JPEG_QUALITY });
    if (Array.isArray(result)) {
      // Multiple images in one HEIF container — take the first.
      return result[0] as Blob;
    }
    return result as Blob;
  }

  if (isWebp(file)) {
    return canvasToJpeg(file);
  }

  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'jpg' || ext === 'jpeg' || file.type === 'image/jpeg') {
    // Already JPG — pass straight through.
    return file;
  }

  if (ext === 'png' || file.type === 'image/png') {
    return canvasToJpeg(file);
  }

  // Fallback: try canvas decode for anything else accepted.
  return canvasToJpeg(file);
}

function toJpgName(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  const base = dot > 0 ? originalName.slice(0, dot) : originalName;
  return `${base}.jpg`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function ImageConverter() {
  const [items, setItems] = useState<ConvertedImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const revokeUrl = (url?: string) => {
    if (url) URL.revokeObjectURL(url);
  };

  // Animate the progress bar of an in-flight item on a rough interval.
  const tickProgress = (id: string) => {
    let p = 6;
    const interval = setInterval(() => {
      p = Math.min(p + Math.max(1, (90 - p) * 0.12), 92);
      setItems((prev) =>
        prev.map((it) =>
          it.id === id && it.status === 'converting'
            ? { ...it, progress: p }
            : it
        )
      );
    }, 180);
    return () => clearInterval(interval);
  };

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    let incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    // --- Soft guard against memory-heavy HEIC batches -----------------------
    // heic2any decodes each HEIC fully in WASM memory with no streaming, so a
    // big batch on an older iPhone can exhaust the tab's memory limit and
    // reload the page. We don't know the device's ceiling, so we surface an
    // honest prompt instead of silently risking a crash — and let the user
    // keep converting the lighter files if they'd rather not push it.
    const heicFiles = incoming.filter(isHeic);
    const heicBytes = heicFiles.reduce((sum, f) => sum + f.size, 0);
    const heavyBatch =
      heicFiles.length > HEIC_BATCH_WARN_COUNT ||
      heicBytes > HEIC_BATCH_WARN_BYTES;
    if (heavyBatch) {
      const proceedHeavy = window.confirm(
        `You're converting ${heicFiles.length} HEIC photo${heicFiles.length === 1 ? '' : 's'} (${formatBytes(heicBytes)}). ` +
        `Decoding HEIC happens entirely in your device's memory, and a batch this large can run out of memory and reload the tab on older iPhones or low-memory devices.\n\n` +
        `• OK — convert them all (one at a time)\n• Cancel — skip the HEIC files and convert the rest`
      );
      if (!proceedHeavy) {
        incoming = incoming.filter((f) => !isHeic(f));
        if (incoming.length === 0) return; // nothing left to do
      }
    }

    // Seed state with pending entries keyed by a stable id.
    const pending: ConvertedImage[] = incoming.map((file) => ({
      id: makeId(),
      originalName: file.name,
      outputName: toJpgName(file.name),
      status: 'converting',
      originalSize: file.size,
      outputSize: 0,
      progress: 5,
      oversized: isHeic(file) && file.size > HEIC_SINGLE_WARN_BYTES,
    }));

    setBusy(true);
    setItems((prev) => [...prev, ...pending]);

    // Convert sequentially to avoid hammering the main thread / heic2any worker.
    for (let i = 0; i < incoming.length; i++) {
      const file = incoming[i];
      const meta = pending[i];
      const stopTick = tickProgress(meta.id);
      try {
        const blob = await convertImage(file);
        const outputUrl = URL.createObjectURL(blob);
        setItems((prev) =>
          prev.map((it) =>
            it.id === meta.id
              ? {
                  ...it,
                  status: 'done',
                  blob,
                  outputUrl,
                  outputSize: blob.size,
                  progress: 100,
                }
              : it
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Conversion failed';
        setItems((prev) =>
          prev.map((it) =>
            it.id === meta.id
              ? { ...it, status: 'error', errorMessage: message, progress: 100 }
              : it
          )
        );
      } finally {
        stopTick();
        // Give the browser a chance to reclaim the decoded image's memory
        // before we decode the next one — meaningful for big HEIC batches on
        // memory-constrained devices where WASM allocations otherwise pile up.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    setBusy(false);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files);
    // Reset so selecting the same file again still fires onChange.
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) processFiles(e.dataTransfer.files);
  };

  const downloadOne = (item: ConvertedImage) => {
    if (!item.outputUrl) return;
    const a = document.createElement('a');
    a.href = item.outputUrl;
    a.download = item.outputName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadAll = async () => {
    const done = items.filter((it) => it.status === 'done' && it.blob);
    if (done.length === 0) return;
    if (done.length === 1) {
      downloadOne(done[0]);
      return;
    }
    setBusy(true);
    try {
      const zip = new JSZip();
      // Guard against duplicate output names by suffixing.
      const used = new Map<string, number>();
      for (const it of done) {
        let name = it.outputName;
        const count = used.get(name) ?? 0;
        if (count > 0) {
          const dot = name.lastIndexOf('.');
          name = `${name.slice(0, dot)} (${count})${name.slice(dot)}`;
        }
        used.set(it.outputName, count + 1);
        zip.file(name, it.blob!);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'converted-images.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  const removeItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((it) => it.id === id);
      revokeUrl(target?.outputUrl);
      return prev.filter((it) => it.id !== id);
    });
  };

  const clearAll = () => {
    items.forEach((it) => revokeUrl(it.outputUrl));
    setItems([]);
  };

  const doneCount = items.filter((it) => it.status === 'done').length;
  const hasMultiple = doneCount > 1;

  return (
    <div className="w-full">
      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={[
          'group relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-all duration-300 cursor-pointer',
          isDragging
            ? 'border-emerald-500 bg-emerald-50/60 ring-4 ring-emerald-500/10 dark:border-emerald-400 dark:bg-emerald-950/50'
            : 'border-neutral-300 bg-neutral-50/40 hover:border-neutral-400 hover:bg-neutral-50 dark:border-slate-700 dark:bg-slate-900/40 dark:hover:border-slate-600 dark:hover:bg-slate-900/70',
        ].join(' ')}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          onChange={handleInputChange}
          className="hidden"
        />

        <span
          className={[
            'flex h-12 w-12 items-center justify-center rounded-full transition-colors duration-300',
            isDragging
              ? 'bg-emerald-500 text-white dark:bg-emerald-400'
              : 'bg-neutral-200 text-neutral-500 group-hover:bg-neutral-300 dark:bg-slate-700 dark:text-slate-400 dark:group-hover:bg-slate-600',
          ].join(' ')}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </span>

        <p className="text-base font-semibold text-neutral-900 transition-colors duration-300 dark:text-white">
          Drag & drop images here or{" "}
          <span className="text-emerald-600 underline-offset-2 group-hover:underline dark:text-emerald-400">
            click to browse
          </span>
        </p>
        <p className="text-sm text-neutral-500 transition-colors duration-300 dark:text-slate-400">
          Supports .heic · .heif · .webp · .jpg · .jpeg · .png — multiple files OK
        </p>
      </div>

      {/* File list */}
      {items.length > 0 && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-neutral-500 transition-colors duration-300 dark:text-slate-400">
              <span className="text-neutral-900 dark:text-white">{doneCount}</span> / {items.length} ready
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={downloadAll}
                disabled={!hasMultiple || busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-2 text-xs font-semibold text-white transition-colors duration-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 dark:disabled:bg-slate-700 dark:disabled:text-slate-500"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download All (ZIP)
              </button>
              <button
                type="button"
                onClick={clearAll}
                disabled={busy}
                className="inline-flex items-center rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-600 transition-colors duration-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Clear
              </button>
            </div>
          </div>

          <ul className="grid gap-2.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-colors duration-300 dark:border-slate-700 dark:bg-slate-800"
              >
                {/* Thumbnail */}
                <div className="relative h-14 w-14 flex-none overflow-hidden rounded-lg bg-neutral-100 ring-1 ring-black/5 transition-colors duration-300 dark:bg-slate-700 dark:ring-white/10">
                  <img
                    src={item.outputUrl ?? placeholder(item.status)}
                    alt=""
                    className={[
                      'h-full w-full object-cover',
                      item.status === 'converting' ? 'opacity-70 blur-[1px]' : 'opacity-100',
                    ].join(' ')}
                  />
                  {item.status === 'converting' && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    </div>
                  )}
                </div>

                {/* Meta + progress */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-neutral-900 transition-colors duration-300 dark:text-white">
                      {item.originalName}
                    </p>
                    <div
                      className={[
                        'items-center gap-1.5 text-xs font-semibold',
                        statusTextClass(item.status),
                      ].join(' ')}
                    >
                      {statusIcon(item.status)}
                      {statusLabel(item.status)}
                    </div>
                  </div>

                  <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500 transition-colors duration-300 dark:text-slate-400">
                    <span className="truncate">{formatBytes(item.originalSize)}</span>
                    {item.status === 'done' && item.outputSize > 0 && (
                      <>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="5 12 10 17 19 7" />
                        </svg>
                        <span className="font-medium text-emerald-600 dark:text-emerald-400">{formatBytes(item.outputSize)}</span>
                      </>
                    )}
                  </div>

                  {item.oversized && item.status !== 'error' && (
                    <p className="mt-1 truncate text-xs text-amber-600 dark:text-amber-400">
                      Large HEIC — decoding uses device memory; if the tab reloads on an older phone, convert fewer at once.
                    </p>
                  )}

                  {/* Progress bar */}
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-neutral-100 transition-colors duration-300 dark:bg-slate-700">
                    <div
                      className={[
                        'h-full rounded-full transition-[width] duration-200 ease-out',
                        item.status === 'error'
                          ? 'bg-red-500'
                          : item.status === 'done'
                            ? 'bg-emerald-500 dark:bg-emerald-400'
                            : 'bg-neutral-900 dark:bg-slate-300',
                      ].join(' ')}
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>

                  {item.status === 'error' && item.errorMessage && (
                    <p className="mt-1.5 truncate text-xs text-red-600 dark:text-red-400">{item.errorMessage}</p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex flex-none gap-1.5">
                  {item.status === 'done' && (
                    <button
                      type="button"
                      onClick={() => downloadOne(item)}
                      className="inline-flex items-center gap-1 rounded-lg bg-neutral-900 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors duration-300 hover:bg-neutral-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
                      aria-label={`Download ${item.outputName}`}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    disabled={busy}
                    aria-label="Remove from list"
                    className="inline-flex items-center rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-neutral-400 transition-colors duration-300 hover:bg-neutral-50 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function statusLabel(status: FileStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'converting':
      return 'Converting';
    case 'done':
      return 'Done';
    case 'error':
      return 'Failed';
  }
}

function statusTextClass(status: FileStatus): string {
  switch (status) {
    case 'pending':
      return 'flex transition-colors duration-300 text-neutral-500 dark:text-slate-400';
    case 'converting':
      return 'flex transition-colors duration-300 text-neutral-700 dark:text-slate-200';
    case 'done':
      return 'flex transition-colors duration-300 text-emerald-600 dark:text-emerald-400';
    case 'error':
      return 'flex transition-colors duration-300 text-red-600 dark:text-red-400';
  }
}

function statusIcon(status: FileStatus) {
  if (status === 'done') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="5 12 10 17 19 7" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  }
  if (status === 'converting') {
    return (
      <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }
  return null;
}

/** A tiny inline placeholder so the thumbnail slot doesn't collapse while converting.
 *  Reads the live theme so the placeholder matches dark mode. */
function placeholder(status: FileStatus): string {
  const label =
    status === 'converting'
      ? ''
      : status === 'error'
        ? '✕'
        : '🖼';
  const isDark =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');
  const bg = isDark ? '#334155' : '#f4f4f5';
  const fg = isDark ? '#94a3b8' : '#a1a1aa';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'>
    <rect width='56' height='56' fill='${bg}'/>
    <text x='50%' y='50%' font-size='22' fill='${fg}' text-anchor='middle' dominant-baseline='central'>${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
