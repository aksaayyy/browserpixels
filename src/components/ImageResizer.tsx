import { useCallback, useEffect, useRef, useState } from 'react';
import {
  resizeImage,
  detectFormat,
  ACCEPTED,
  outputFileName,
  computeTargetSize,
  readDimensions,
  type ResizeMode,
  type ResizeResult,
} from '../lib/resize-image';

type Status = 'ready' | 'resizing' | 'done' | 'error';

interface SourceInfo {
  file: File;
  width: number;
  height: number;
  /** preview object URL for the original */
  previewUrl: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}`;
}

const NUM_RX = /^\d+$/;

const MODE_LABEL: Record<ResizeMode, string> = {
  dimensions: 'Exact Dimensions',
  percent: 'Percentage Scale',
};

type PresetKey =
  | 'custom'
  | 'instagram-square'
  | 'instagram-story'
  | 'twitter-post'
  | 'discord-emoji'
  | 'hd-wallpaper'
  | 'email-attachment';

interface Preset {
  key: PresetKey;
  label: string;
  mode: ResizeMode;
  /** fixed pixels, applied only in dimensions mode */
  width?: number;
  height?: number;
  /** applied only in percent mode */
  percent?: number;
  /** lock aspect to the preset's own ratio (not the source's) */
  lockAspect?: boolean;
}

const PRESETS: Preset[] = [
  { key: 'custom', label: 'Custom (Manual)', mode: 'dimensions' },
  { key: 'instagram-square', label: 'Instagram Square (1080×1080)', mode: 'dimensions', width: 1080, height: 1080, lockAspect: true },
  { key: 'instagram-story', label: 'Instagram Story / Reel (1080×1920)', mode: 'dimensions', width: 1080, height: 1920, lockAspect: true },
  { key: 'twitter-post', label: 'Twitter / X Post (1600×900)', mode: 'dimensions', width: 1600, height: 900, lockAspect: true },
  { key: 'discord-emoji', label: 'Discord Emoji (128×128)', mode: 'dimensions', width: 128, height: 128, lockAspect: false },
  { key: 'hd-wallpaper', label: 'HD Wallpaper 1080p (1920×1080)', mode: 'dimensions', width: 1920, height: 1080, lockAspect: true },
  { key: 'email-attachment', label: 'Email Attachment (Scale down 50%)', mode: 'percent', percent: 50 },
];

/**
 * Props the pSEO landing pages pass in so the tool loads already configured to
 * the long-tail keyword's target dimensions (e.g. 1080×1080 for the Instagram
 * page). All optional — the default /resize-image page renders the component
 * with no preset, exactly as before. Only the initial values are seeded; the
 * user can still change everything afterwards (the fields are live).
 */
export interface ImageResizerProps {
  /** 'exact' seeds exact width/height; 'percent' seeds a percentage scale. */
  presetMode?: 'exact' | 'percent';
  presetWidth?: number;
  presetHeight?: number;
  presetPercent?: number;
}

export default function ImageResizer({
  presetMode,
  presetWidth,
  presetHeight,
  presetPercent,
}: ImageResizerProps = {}) {
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [status, setStatus] = useState<Status>('ready');
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [isDragging, setIsDragging] = useState(false);

  const [mode, setMode] = useState<ResizeMode>('dimensions');
  const [widthInput, setWidthInput] = useState('');
  const [heightInput, setHeightInput] = useState('');
  const [maintainAspect, setMaintainAspect] = useState(true);
  const [percent, setPercent] = useState(50);
  const [preset, setPreset] = useState<PresetKey>('custom');

  const [result, setResult] = useState<ResizeResult | null>(null);
  const [resultId, setResultId] = useState<string>('');

  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks that the pSEO preset seeded specific target dimensions/percent, so
  // loadFile() knows not to overwrite them with the source's original dimensions
  // on the first file load. Once the user edits a field themselves (which sets
  // preset='custom'), this flips false and original-dimension seeding resumes.
  const presetSeeded = useRef(false);

  // Clean up object URLs when the source/result changes or unmounts.
  const revokeUrl = (url?: string) => {
    if (url) URL.revokeObjectURL(url);
  };
  useEffect(() => {
    return () => {
      revokeUrl(source?.previewUrl);
      revokeUrl(result?.outputUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the tool's initial state from the pSEO preset props once on mount.
  // The main /resize-image page passes nothing and keeps the default 'Custom'
  // blank state; a landing page like /resize-image-for-instagram passes
  // presetMode='exact' + 1080×1080 so the user lands already configured and
  // can drop a file in and resize in one step. The fields stay fully editable
  // afterwards.
  useEffect(() => {
    if (presetMode === 'exact' && (presetWidth || presetHeight)) {
      setMode('dimensions');
      setMaintainAspect(false);
      if (presetWidth) setWidthInput(String(presetWidth));
      if (presetHeight) setHeightInput(String(presetHeight));
      presetSeeded.current = true;
    } else if (presetMode === 'percent' && typeof presetPercent === 'number') {
      setMode('percent');
      setPercent(presetPercent);
      presetSeeded.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When exact-dimensions mode is active and aspect lock is on, editing one
  // field auto-fills the other from the source's aspect ratio so the user
  // sees the implied dimension live, before they even hit resize.
  const aspect = source ? source.width / source.height : 1;
  const computed = source
    ? computeTargetSize(source.width, source.height, {
        mode,
        width: widthInput ? Number(widthInput) : 0,
        height: heightInput ? Number(heightInput) : 0,
        maintainAspect,
        percent,
      })
    : { width: 0, height: 0 };

  const loadFile = useCallback(async (file: File) => {
    const fmt = detectFormat(file);
    if (!fmt) {
      setSource(null);
      setStatus('error');
      setErrorMessage('Unsupported type — use JPG, PNG, or WebP.');
      return;
    }
    // Decode just to read pixel dimensions for the live preview. Use an <img>
    // (cheap) instead of the full resize pipeline; we don't need a bitmap here.
    try {
      const dims = await readDimensions(file);
      revokeUrl(result?.outputUrl);
      revokeUrl(source?.previewUrl);
      setResult(null);
      setStatus('ready');
      setErrorMessage(undefined);
      // Seed width/height with the original so the user can tweak from a known
      // number — UNLESS a pSEO preset pre-configured the tool (e.g. the
      // Instagram page lands with 1080×1080 filled in). In that case we keep
      // the preset values so the page's promise ("already set, just drop and
      // resize") holds on the first load. The user keeps the preset until they
      // edit a field themselves, which clears it (see setPreset('custom') on
      // the inputs) and re-enables original-dimension seeding on the next load.
      if (!presetSeeded.current) {
        setWidthInput(String(dims.width));
        setHeightInput(String(dims.height));
      }
      setSource({
        file,
        width: dims.width,
        height: dims.height,
        previewUrl: URL.createObjectURL(file),
      });
    } catch {
      setSource(null);
      setStatus('error');
      setErrorMessage('This file could not be decoded as an image.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, result]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  };

  const runResize = useCallback(async () => {
    if (!source) return;
    setStatus('resizing');
    setErrorMessage(undefined);
    try {
      const res = await resizeImage(source.file, {
        mode,
        width: widthInput ? Number(widthInput) : undefined,
        height: heightInput ? Number(heightInput) : undefined,
        maintainAspect,
        percent,
      });
      revokeUrl(result?.outputUrl);
      setResult(res);
      setResultId(makeId());
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not resize this image.'
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, mode, widthInput, heightInput, maintainAspect, percent, result]);

  const download = () => {
    if (!result || !source) return;
    const a = document.createElement('a');
    a.href = result.outputUrl;
    a.download = outputFileName(source.file.name, result.format, result.width, result.height);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const clearAll = () => {
    revokeUrl(source?.previewUrl);
    revokeUrl(result?.outputUrl);
    setSource(null);
    setResult(null);
    setStatus('ready');
    setErrorMessage(undefined);
    setWidthInput('');
    setHeightInput('');
    setPercent(50);
    setMaintainAspect(true);
    setPreset('custom');
    presetSeeded.current = false;
    if (inputRef.current) inputRef.current.value = '';
  };

  const applyPreset = (key: PresetKey) => {
    setPreset(key);
    const p = PRESETS.find((x) => x.key === key);
    if (!p || key === 'custom') return;
    setMode(p.mode);
    // Selecting a Quick Preset (vs. the pSEO mount preset) is a user action —
    // clear the pSEO seed so a subsequent file load falls back to original dims.
    presetSeeded.current = false;
    if (p.mode === 'dimensions') {
      setWidthInput(String(p.width ?? ''));
      setHeightInput(String(p.height ?? ''));
      // Aspect lock behavior: emoji presets force unlock, others lock to the
      // preset's exact ratio regardless of the source's original aspect.
      if (p.lockAspect === false) {
        setMaintainAspect(false);
      } else {
        setMaintainAspect(true);
      }
    } else if (p.mode === 'percent' && typeof p.percent === 'number') {
      setPercent(p.percent);
    }
  };

  const canResize =
    !!source &&
    status !== 'resizing' &&
    (mode === 'percent'
      ? percent >= 1 && percent <= 200
      : (Number(widthInput) >= 1 || Number(heightInput) >= 1));

  // When a dimension field is edited with aspect lock on, recompute the
  // partner field as a live helper label (we keep the user's typed value as
  // the source of truth and only show the computed partner for display).
  const impliedHeight =
    maintainAspect && widthInput && NUM_RX.test(String(widthInput))
      ? Math.max(1, Math.round(Number(widthInput) / aspect))
      : null;
  const impliedWidth =
    maintainAspect && heightInput && NUM_RX.test(String(heightInput))
      ? Math.max(1, Math.round(Number(heightInput) * aspect))
      : null;

  return (
    <div className="w-full">
      {/* Drop zone (shown when no source loaded) */}
      {!source && (
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
            'group flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-all duration-300 cursor-pointer',
            isDragging
              ? 'border-emerald-500 bg-emerald-50/60 ring-4 ring-emerald-500/10 dark:border-emerald-400 dark:bg-emerald-950/50'
              : 'border-neutral-300 bg-neutral-50/40 hover:border-neutral-400 hover:bg-neutral-50 dark:border-slate-700 dark:bg-slate-900/40 dark:hover:border-slate-600 dark:hover:bg-slate-900/70',
          ].join(' ')}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
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
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </span>
          <p className="text-base font-semibold text-neutral-900 transition-colors duration-300 dark:text-white">
            Drag & drop an image here or{' '}
            <span className="text-emerald-600 underline-offset-2 group-hover:underline dark:text-emerald-400">
              click to browse
            </span>
          </p>
          <p className="text-sm text-neutral-500 transition-colors duration-300 dark:text-slate-400">
            Supports .jpg · .jpeg · .png · .webp
          </p>
          {status === 'error' && errorMessage && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
          )}
        </div>
      )}

      {/* Controls + preview (shown once a source is loaded) */}
      {source && (
        <div className="space-y-4">
          {/* Source summary */}
          <div className="flex items-center gap-4 rounded-xl border border-neutral-200 bg-neutral-50/40 p-4 transition-colors duration-300 dark:border-slate-700 dark:bg-slate-900/40">
            <div className="relative h-16 w-16 flex-none overflow-hidden rounded-lg bg-neutral-100 ring-1 ring-black/5 transition-colors duration-300 dark:bg-slate-700 dark:ring-white/10">
              <img
                src={source.previewUrl}
                alt={source.file.name}
                className="h-full w-full object-contain"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-neutral-900 transition-colors duration-300 dark:text-white">
                {source.file.name}
              </p>
              <p className="mt-0.5 text-xs text-neutral-500 transition-colors duration-300 dark:text-slate-400">
                Original: <span className="font-medium text-neutral-700 dark:text-slate-200 tabular-nums">{source.width}×{source.height}</span> · {formatBytes(source.file.size)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="inline-flex flex-none items-center rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-600 transition-colors duration-300 hover:bg-neutral-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Change
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              onChange={handleInputChange}
              className="hidden"
            />
          </div>

          {/* Quick Presets */}
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/40 p-4 transition-colors duration-300 dark:border-slate-700 dark:bg-slate-900/40 sm:p-5">
            <label
              htmlFor="preset-select"
              className="mb-2 block text-xs font-semibold uppercase tracking-wide text-neutral-500 transition-colors duration-300 dark:text-slate-400"
            >
              Quick Presets
            </label>
            <select
              id="preset-select"
              value={preset}
              onChange={(e) => applyPreset(e.target.value as PresetKey)}
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-900 transition-colors duration-300 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-neutral-500 transition-colors duration-300 dark:text-slate-400">
              {preset === 'custom'
                ? 'Pick a preset to auto-fill dimensions, or set your own below.'
                : `Preset applied — adjust manually below if needed. Aspect ratio is ${
                    PRESETS.find((p) => p.key === preset)?.lockAspect === false ? 'unlocked' : 'locked to the preset'
                  }.`}
            </p>
          </div>

          {/* Mode toggle */}
          <div className="rounded-xl border border-neutral-200 bg-neutral-50/40 p-4 transition-colors duration-300 dark:border-slate-700 dark:bg-slate-900/40 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 transition-colors duration-300 dark:text-slate-400">
                Mode
              </span>
              {(['dimensions', 'percent'] as const).map((m) => {
                const active = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMode(m);
                      setPreset('custom');
                      presetSeeded.current = false;
                    }}
                    className={[
                      'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors duration-300',
                      active
                        ? 'bg-emerald-500 text-white dark:bg-emerald-400'
                        : 'border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
                    ].join(' ')}
                  >
                    {MODE_LABEL[m]}
                  </button>
                );
              })}
            </div>

            {/* Dimensions mode inputs */}
            {mode === 'dimensions' && (
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-end gap-4">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-neutral-500 transition-colors duration-300 dark:text-slate-400">
                      Width (px)
                    </span>
                    <input
                      type="number"
                      min={1}
                      inputMode="numeric"
                      value={widthInput}
                      onChange={(e) => {
                        setWidthInput(e.target.value);
                        setPreset('custom');
                        presetSeeded.current = false;
                      }}
                      className="w-32 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-900 transition-colors duration-300 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-neutral-500 transition-colors duration-300 dark:text-slate-400">
                      Height (px)
                    </span>
                    <input
                      type="number"
                      min={1}
                      inputMode="numeric"
                      value={heightInput}
                      onChange={(e) => {
                        setHeightInput(e.target.value);
                        setPreset('custom');
                        presetSeeded.current = false;
                      }}
                      className="w-32 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-900 transition-colors duration-300 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                    />
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-sm font-medium text-neutral-700 transition-colors duration-300 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={maintainAspect}
                      onChange={(e) => {
                        setMaintainAspect(e.target.checked);
                        setPreset('custom');
                        presetSeeded.current = false;
                      }}
                      className="h-4 w-4 rounded accent-emerald-500"
                    />
                    Maintain aspect ratio
                  </label>
                </div>
                <p className="text-xs text-neutral-500 transition-colors duration-300 dark:text-slate-400">
                  {maintainAspect && impliedHeight && widthInput
                    ? `Heights auto-locks to ≈ ${impliedHeight}px from width (${source.width}×${source.height}).`
                    : maintainAspect && impliedWidth && heightInput
                    ? `Width auto-locks to ≈ ${impliedWidth}px from height.`
                    : maintainAspect
                    ? 'Edit width or height — the other recalculates to keep the aspect ratio.'
                    : 'Aspect ratio unlocked — set width and height independently (may stretch).'}
                </p>
              </div>
            )}

            {/* Percent mode slider */}
            {mode === 'percent' && (
              <div className="mt-4 flex items-center gap-3">
                <label
                  htmlFor="percent"
                  className="whitespace-nowrap text-xs font-semibold text-neutral-500 transition-colors duration-300 dark:text-slate-400"
                >
                  Scale
                </label>
                <input
                  id="percent"
                  type="range"
                  min={1}
                  max={200}
                  step={1}
                  value={percent}
                  onChange={(e) => {
                    setPercent(Number(e.target.value));
                    setPreset('custom');
                    presetSeeded.current = false;
                  }}
                  className="h-2 w-full cursor-pointer appearance-none rounded-full bg-neutral-200 accent-emerald-500 dark:bg-slate-700"
                />
                <span className="w-12 text-right text-sm font-semibold tabular-nums text-neutral-900 transition-colors duration-300 dark:text-white">
                  {percent}%
                </span>
              </div>
            )}

            {/* Live result-dimension preview */}
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs text-neutral-600 transition-colors duration-300 dark:bg-slate-800/60 dark:text-slate-300">
              <span className="font-medium text-neutral-900 tabular-nums dark:text-white">{source.width}×{source.height}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
              <span className="font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">{computed.width}×{computed.height}</span>
              <span className="text-neutral-400 dark:text-slate-500">target</span>
            </div>

            {/* Action buttons */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={runResize}
                disabled={!canResize}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors duration-300 hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-400 dark:hover:bg-emerald-500"
              >
                {status === 'resizing' ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3L21 8" />
                    <path d="M21 3v5h-5" />
                  </svg>
                )}
                {status === 'resizing' ? 'Resizing…' : 'Resize Image'}
              </button>
              <button
                type="button"
                onClick={clearAll}
                disabled={status === 'resizing'}
                className="inline-flex items-center rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-600 transition-colors duration-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Clear / Reset
              </button>
            </div>
            {status === 'error' && errorMessage && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
            )}
          </div>

          {/* Result */}
          {status === 'done' && result && (
            <div
              key={resultId}
              className="overflow-hidden rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 transition-colors duration-300 dark:border-emerald-900/60 dark:bg-emerald-950/30"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <div className="relative h-16 w-16 flex-none overflow-hidden rounded-lg bg-white ring-1 ring-black/5 transition-colors duration-300 dark:bg-slate-800 dark:ring-white/10">
                    <img
                      src={result.outputUrl}
                      alt="Resized preview"
                      className="h-full w-full object-contain"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-neutral-900 transition-colors duration-300 dark:text-white">
                      Resized to {result.width}×{result.height}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500 transition-colors duration-300 dark:text-slate-400">
                      {source.width}×{source.height} → {result.width}×{result.height} · {formatBytes(source.file.size)} → {formatBytes(result.resizedSize)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={download}
                  className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-300 hover:bg-neutral-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download Resized Image
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
