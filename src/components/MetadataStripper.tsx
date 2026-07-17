import { useCallback, useRef, useState } from 'react';
import JSZip from 'jszip';
import { stripMetadata, type FoundTag } from '../lib/metadata';

type FileStatus = 'scanning' | 'done' | 'error';

interface CleanedImage {
  id: string;
  name: string;
  status: FileStatus;
  errorMessage?: string;
  blob?: Blob;
  outputUrl?: string;
  mimeType: string;
  originalSize: number;
  cleanedSize: number;
  tags: FoundTag[];
  hasGps: boolean;
  hadAnyMetadata: boolean;
  expanded: boolean;
}

const ACCEPTED = '.jpg,.jpeg,.png,.webp';

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function MetadataStripper() {
  const [items, setItems] = useState<CleanedImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const revokeUrl = (url?: string) => {
    if (url) URL.revokeObjectURL(url);
  };

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    const pending: CleanedImage[] = incoming.map((file) => ({
      id: makeId(),
      name: file.name,
      status: 'scanning',
      mimeType: file.type || 'application/octet-stream',
      originalSize: file.size,
      cleanedSize: 0,
      tags: [],
      hasGps: false,
      hadAnyMetadata: false,
      expanded: false,
    }));

    setBusy(true);
    setItems((prev) => [...prev, ...pending]);

    for (let i = 0; i < incoming.length; i++) {
      const file = incoming[i];
      const meta = pending[i];
      try {
        const result = await stripMetadata(file);
        const blob = new Blob([result.cleaned], { type: file.type || 'application/octet-stream' });
        const outputUrl = URL.createObjectURL(blob);
        setItems((prev) =>
          prev.map((it) =>
            it.id === meta.id
              ? {
                  ...it,
                  status: 'done',
                  blob,
                  outputUrl,
                  cleanedSize: result.cleanedBytes,
                  tags: result.tags,
                  hasGps: result.hasGps,
                  hadAnyMetadata: result.hadAnyMetadata,
                }
              : it
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not read this file';
        setItems((prev) =>
          prev.map((it) => (it.id === meta.id ? { ...it, status: 'error', errorMessage: message } : it))
        );
      }
    }
    setBusy(false);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) processFiles(e.dataTransfer.files);
  };

  const downloadOne = (item: CleanedImage) => {
    if (!item.outputUrl) return;
    const a = document.createElement('a');
    a.href = item.outputUrl;
    a.download = item.name;
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
      const used = new Map<string, number>();
      for (const it of done) {
        let name = it.name;
        const count = used.get(it.name) ?? 0;
        if (count > 0) {
          const dot = name.lastIndexOf('.');
          name = dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
        }
        used.set(it.name, count + 1);
        zip.file(name, it.blob!);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cleaned-images.zip';
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

  const toggleExpanded = (id: string) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, expanded: !it.expanded } : it)));
  };

  const doneCount = items.filter((it) => it.status === 'done').length;
  const hasMultiple = doneCount > 1;
  const gpsCount = items.filter((it) => it.status === 'done' && it.hasGps).length;

  return (
    <div className="w-full">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
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
        <input ref={inputRef} type="file" accept={ACCEPTED} multiple onChange={handleInputChange} className="hidden" />

        <span
          className={[
            'flex h-12 w-12 items-center justify-center rounded-full transition-colors duration-300',
            isDragging
              ? 'bg-emerald-500 text-white dark:bg-emerald-400'
              : 'bg-neutral-200 text-neutral-500 group-hover:bg-neutral-300 dark:bg-slate-700 dark:text-slate-400 dark:group-hover:bg-slate-600',
          ].join(' ')}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        </span>

        <p className="text-base font-semibold text-neutral-900 transition-colors duration-300 dark:text-white">
          Drag & drop photos here or{' '}
          <span className="text-emerald-600 underline-offset-2 group-hover:underline dark:text-emerald-400">click to browse</span>
        </p>
        <p className="text-sm text-neutral-500 transition-colors duration-300 dark:text-slate-400">
          Supports .jpg · .jpeg · .png · .webp — multiple files OK
        </p>
      </div>

      {items.length > 0 && (
        <div className="mt-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-neutral-500 transition-colors duration-300 dark:text-slate-400">
              <span className="text-neutral-900 dark:text-white">{doneCount}</span> / {items.length} scanned
              {gpsCount > 0 && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600 dark:bg-red-950 dark:text-red-400">
                  {gpsCount} had GPS location
                </span>
              )}
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
                className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-colors duration-300 dark:border-slate-700 dark:bg-slate-800"
              >
                <div className="flex items-center gap-3">
                  <div className="relative flex h-11 w-11 flex-none items-center justify-center overflow-hidden rounded-lg bg-neutral-100 ring-1 ring-black/5 transition-colors duration-300 dark:bg-slate-700 dark:ring-white/10">
                    {item.status === 'scanning' ? (
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-slate-600 dark:border-t-slate-300" />
                    ) : item.status === 'error' ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-neutral-900 transition-colors duration-300 dark:text-white">{item.name}</p>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-neutral-500 transition-colors duration-300 dark:text-slate-400">
                      {item.status === 'scanning' && <span>Scanning…</span>}
                      {item.status === 'error' && <span className="text-red-600 dark:text-red-400">{item.errorMessage}</span>}
                      {item.status === 'done' && (
                        <>
                          <span>{formatBytes(item.originalSize)} → {formatBytes(item.cleanedSize)}</span>
                          {item.hadAnyMetadata ? (
                            <span className="font-medium text-emerald-600 dark:text-emerald-400">
                              {item.tags.length} tag{item.tags.length === 1 ? '' : 's'} removed
                            </span>
                          ) : (
                            <span className="text-neutral-400 dark:text-slate-500">no metadata found</span>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-none gap-1.5">
                    {item.status === 'done' && item.hadAnyMetadata && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(item.id)}
                        aria-label="Show removed metadata"
                        className="inline-flex items-center rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-neutral-500 transition-colors duration-300 hover:bg-neutral-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700"
                      >
                        <svg
                          className={['h-3.5 w-3.5 transition-transform duration-200', item.expanded ? 'rotate-180' : ''].join(' ')}
                          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    )}
                    {item.status === 'done' && (
                      <button
                        type="button"
                        onClick={() => downloadOne(item)}
                        className="inline-flex items-center gap-1 rounded-lg bg-neutral-900 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors duration-300 hover:bg-neutral-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
                        aria-label={`Download cleaned ${item.name}`}
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
                </div>

                {item.status === 'done' && item.expanded && item.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-neutral-100 pt-3 transition-colors duration-300 dark:border-slate-700">
                    {item.tags.map((tag, i) => (
                      <span
                        key={i}
                        className={[
                          'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                          tag.sensitive
                            ? 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400'
                            : 'bg-neutral-100 text-neutral-600 dark:bg-slate-700 dark:text-slate-300',
                        ].join(' ')}
                      >
                        <strong className="font-semibold">{tag.label}:</strong> {tag.value}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
