import { useCallback, useRef, useState } from 'react';
import {
	compressImage,
	detectFormat,
	ACCEPTED,
	outputFileName,
	type CompressFormat,
	type CompressResult,
} from '../lib/compress-image';

type FileStatus = 'compressing' | 'done' | 'error';

interface CompressedItem {
	id: string;
	name: string;
	status: FileStatus;
	errorMessage?: string;
	result?: CompressResult;
	originalSize: number;
	/** whether the compressed blob came out larger than the original */
	larger?: boolean;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function reductionPct(orig: number, comp: number): string {
	if (orig === 0) return '0%';
	const pct = Math.round((1 - comp / orig) * 100);
	// Negative pct means compression produced a bigger file.
	return `${pct >= 0 ? pct : pct}%`;
}

function makeId(): string {
	return `${Date.now().toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}`;
}

const FORMAT_LABEL: Record<CompressFormat, string> = {
	jpeg: 'JPEG',
	png: 'PNG',
	webp: 'WebP',
};

export default function ImageCompressor() {
	const [items, setItems] = useState<CompressedItem[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const [quality, setQuality] = useState(80); // 1–100 (slider range), maps to 0–1
	const [outputFmt, setOutputFmt] = useState<CompressFormat | 'keep'>('keep');
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const revokeUrl = (url?: string) => {
		if (url) URL.revokeObjectURL(url);
	};

	const resolveFormat = (file: File): CompressFormat | null => {
		if (outputFmt !== 'keep') return outputFmt;
		return detectFormat(file);
	};

	const processFiles = useCallback(
		async (fileList: FileList | File[]) => {
			const incoming = Array.from(fileList);
			if (incoming.length === 0) return;

			const pending: CompressedItem[] = incoming.map((file) => ({
				id: makeId(),
				name: file.name,
				status: 'compressing',
				originalSize: file.size,
			}));

			setBusy(true);
			setItems((prev) => [...prev, ...pending]);

			for (let i = 0; i < incoming.length; i++) {
				const file = incoming[i];
				const meta = pending[i];
				const fmt = resolveFormat(file);
				if (!fmt) {
					setItems((prev) =>
						prev.map((it) =>
							it.id === meta.id
								? {
										...it,
										status: 'error',
										errorMessage: 'Unsupported type — use JPG, PNG, or WebP.',
									}
								: it
						)
					);
					continue;
				}
				try {
					const result = await compressImage(file, {
						format: fmt,
						quality: quality / 100,
					});
					setItems((prev) =>
						prev.map((it) =>
							it.id === meta.id
								? {
										...it,
										status: 'done',
										result,
										larger: result.compressedSize > result.originalSize,
									}
								: it
						)
					);
				} catch (err) {
					const message =
						err instanceof Error ? err.message : 'Could not compress this image.';
					setItems((prev) =>
						prev.map((it) =>
							it.id === meta.id ? { ...it, status: 'error', errorMessage: message } : it
						)
					);
				}
			}
			setBusy(false);
		},
		[quality, outputFmt]
	);

	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files) processFiles(e.target.files);
		e.target.value = '';
	};

	const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setIsDragging(false);
		if (e.dataTransfer.files) processFiles(e.dataTransfer.files);
	};

	const downloadOne = (item: CompressedItem) => {
		if (!item.result) return;
		const a = document.createElement('a');
		a.href = item.result.outputUrl;
		a.download = outputFileName(item.name, item.result.format);
		document.body.appendChild(a);
		a.click();
		a.remove();
	};

	const removeItem = (id: string) => {
		setItems((prev) => {
			const target = prev.find((it) => it.id === id);
			revokeUrl(target?.result?.outputUrl);
			return prev.filter((it) => it.id !== id);
		});
	};

	const clearAll = () => {
		items.forEach((it) => revokeUrl(it.result?.outputUrl));
		setItems([]);
	};

	const doneCount = items.filter((it) => it.status === 'done').length;
	const totalOrig = items
		.filter((it) => it.status === 'done')
		.reduce((n, it) => n + it.originalSize, 0);
	const totalComp = items
		.filter((it) => it.status === 'done')
		.reduce((n, it) => n + (it.result?.compressedSize ?? 0), 0);

	// PNG can't be quality-scaled by the canvas encoder; the slider would do
	// nothing. Disable it then and explain why, so the UI never lies.
	const pngOnly = outputFmt === 'png';

	return (
		<div className="w-full">
			{/* Quality + format controls */}
			<div className="rounded-xl border border-neutral-200 bg-neutral-50/40 p-4 transition-colors duration-300 dark:border-slate-700 dark:bg-slate-900/40 sm:p-5">
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 transition-colors duration-300 dark:text-slate-400">
							Output
						</span>
						{(['keep', 'jpeg', 'png', 'webp'] as const).map((f) => {
							const active = outputFmt === f;
							return (
								<button
									key={f}
									type="button"
									onClick={() => setOutputFmt(f)}
								className={[
										'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors duration-300',
										active
											? 'bg-emerald-500 text-white dark:bg-emerald-400'
											: 'border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
									].join(' ')}
								>
									{f === 'keep' ? 'Match input' : FORMAT_LABEL[f]}
								</button>
							);
						})}
					</div>

					<div className="flex min-w-[15rem] items-center gap-3">
						<label
							htmlFor="quality"
							className="whitespace-nowrap text-xs font-semibold text-neutral-500 transition-colors duration-300 dark:text-slate-400"
						>
							Quality
						</label>
						<input
							id="quality"
							type="range"
							min={10}
							max={100}
							step={5}
							value={quality}
							onChange={(e) => setQuality(Number(e.target.value))}
							disabled={pngOnly}
							className="h-2 w-full cursor-pointer appearance-none rounded-full bg-neutral-200 accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700"
						/>
						<span className="w-9 text-right text-sm font-semibold tabular-nums text-neutral-900 transition-colors duration-300 dark:text-white">
							{quality}%
						</span>
					</div>
				</div>
				{pngOnly && (
					<p className="mt-3 text-xs text-neutral-500 transition-colors duration-300 dark:text-slate-400">
						PNG is a lossless format — the quality slider has no effect on it. To shrink a
						PNG, switch the output to JPEG or WebP.
					</p>
				)}
			</div>

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
					'group mt-4 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-all duration-300 cursor-pointer',
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
					Drag & drop images here or{' '}
					<span className="text-emerald-600 underline-offset-2 group-hover:underline dark:text-emerald-400">
						click to browse
					</span>
				</p>
				<p className="text-sm text-neutral-500 transition-colors duration-300 dark:text-slate-400">
					Supports .jpg · .jpeg · .png · .webp — multiple files OK
				</p>
			</div>

			{items.length > 0 && (
				<div className="mt-6">
					<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
						<span className="text-sm font-medium text-neutral-500 transition-colors duration-300 dark:text-slate-400">
							<span className="text-neutral-900 dark:text-white">{doneCount}</span> /{' '}
							{items.length} compressed
							{doneCount > 0 && totalOrig > 0 && (
								<span className="ml-2 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
									{formatBytes(totalOrig)} → {formatBytes(totalComp)} ·{' '}
									{reductionPct(totalOrig, totalComp)} overall
								</span>
							)}
						</span>
						<button
							type="button"
							onClick={clearAll}
							disabled={busy}
							className="inline-flex items-center rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-600 transition-colors duration-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
						>
							Clear / Reset
						</button>
					</div>

					<ul className="grid gap-2.5">
						{items.map((item) => (
							<li
								key={item.id}
								className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-colors duration-300 dark:border-slate-700 dark:bg-slate-800"
							>
								<div className="flex items-center gap-3">
									<div className="relative flex h-11 w-11 flex-none items-center justify-center overflow-hidden rounded-lg bg-neutral-100 ring-1 ring-black/5 transition-colors duration-300 dark:bg-slate-700 dark:ring-white/10">
										{item.status === 'compressing' ? (
											<span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-slate-600 dark:border-t-slate-300" />
										) : item.status === 'error' ? (
											<svg
												width="18"
												height="18"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												className="text-red-500"
											>
												<line x1="18" y1="6" x2="6" y2="18" />
												<line x1="6" y1="6" x2="18" y2="18" />
											</svg>
										) : (
											<svg
												width="18"
												height="18"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
												className="text-emerald-500"
											>
												<polyline points="20 6 9 17 4 12" />
											</svg>
										)}
									</div>

									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-semibold text-neutral-900 transition-colors duration-300 dark:text-white">
											{item.name}
										</p>
										<div className="mt-0.5 flex items-center gap-2 text-xs text-neutral-500 transition-colors duration-300 dark:text-slate-400">
											{item.status === 'compressing' && <span>Compressing…</span>}
											{item.status === 'error' && (
												<span className="text-red-600 dark:text-red-400">{item.errorMessage}</span>
											)}
											{item.status === 'done' && item.result && (
												<>
													<span>
														{formatBytes(item.originalSize)} →{' '}
														{formatBytes(item.result.compressedSize)}
													</span>
													{item.larger ? (
														<span className="font-medium text-amber-600 dark:text-amber-400">
															already small — output larger
														</span>
													) : (
														<span className="font-medium text-emerald-600 dark:text-emerald-400">
															{reductionPct(item.originalSize, item.result.compressedSize)}{' '}
											reduction
														</span>
													)}
												</>
											)}
										</div>
									</div>

									<div className="flex flex-none gap-1.5">
										{item.status === 'done' && item.result && (
											<button
												type="button"
												onClick={() => downloadOne(item)}
												className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors duration-300 hover:bg-neutral-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
												aria-label={`Download compressed ${item.name}`}
											>
												<svg
													width="13"
													height="13"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
												>
													<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
													<polyline points="7 10 12 15 17 10" />
													<line x1="12" y1="15" x2="12" y2="3" />
												</svg>
												Download
											</button>
										)}
										<button
											type="button"
											onClick={() => removeItem(item.id)}
											disabled={busy}
											aria-label="Remove from list"
											className="inline-flex items-center rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-neutral-400 transition-colors duration-300 hover:bg-neutral-50 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200"
										>
											<svg
												width="13"
												height="13"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<line x1="18" y1="6" x2="6" y2="18" />
												<line x1="6" y1="6" x2="18" y2="18" />
											</svg>
										</button>
									</div>
								</div>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
