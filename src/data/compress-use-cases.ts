/**
 * Programmatic-SEO use-case data for the Image Compressor.
 *
 * Each entry powers one landing page at browserpixels.com/[slug], generated via
 * getStaticPaths in src/pages/[slug].astro. The page leans on the existing
 * ImageCompressor component — the data here just pre-configures it to the
 * quality level the long-tail keyword targets (e.g. "compress image to 1MB" →
 * the Small ~45% preset, which reliably brings a typical JPEG under 1MB), and
 * supplies page-level SEO copy (title, description, H1, JSON-LD).
 *
 * `presetQuality` is the slider value (1–100) the component seeds on mount; it
 * maps 1:1 to `quality/100` passed to the canvas encoder. `presetLabel` is the
 * human label shown in the Quick Presets dropdown, and must match one of the
 * QUALITY_PRESETS labels in ImageCompressor.tsx so the dropdown reflects the
 * same preset the page promised (small / medium / high / max-compression).
 *
 * Keep slugs lowercase-hyphenated and aligned to the search query they target.
 */

export type ToolKind = 'resizer' | 'compressor';

export interface CompressUseCase {
	/** Discriminator telling [slug].astro which React component to render. */
	tool: 'compressor';
	slug: string;
	/** <title> text for the page. Keep under ~60 chars. */
	title: string;
	/** Visible H1. */
	h1: string;
	/** Meta description — keep under ~155 chars. */
	description: string;
	/** Quality slider value (1–100) the component seeds on mount. */
	presetQuality: number;
	/**
	 * Label matching a QUALITY_PRESETS entry in ImageCompressor.tsx, so the
	 * Quick Presets dropdown opens already on the page's preset.
	 */
	presetLabel: string;
	/** Body copy paragraph shown under the tool. */
	copy: string;
}

export const compressUseCases: CompressUseCase[] = [
	{
		tool: 'compressor',
		slug: 'compress-image-to-1mb',
		title: 'Compress Image to 1MB',
		h1: 'Compress Image to 1MB',
		description:
			'Compress JPG, PNG, or WebP images down under 1MB for email and upload portals. Loads set to the Small (~45% quality) preset. Free, no upload.',
		presetQuality: 45,
		presetLabel: 'Small (Email/Web) — ~45%',
		copy: 'Many email clients and upload forms reject anything over 1MB. The Small preset (~45% quality) reliably brings a typical multi-megabyte JPEG down under 1MB while staying perfectly viewable. The tool loads already set to that preset — drop your photo in and download a sub-1MB copy in one click.',
	},
	{
		tool: 'compressor',
		slug: 'compress-image-for-email',
		title: 'Compress Image for Email',
		h1: 'Compress Image for Email',
		description:
			'Shrink images for email attachments so they actually send. Loads set to the Small (~45% quality) preset. Free, 100% in-browser, no upload.',
		presetQuality: 45,
		presetLabel: 'Small (Email/Web) — ~45%',
		copy: 'Email providers cap attachment size and slowly load oversized inline images. Scaling quality down to the Small preset (~45%) cuts the file enough to sail through most inboxes without a visible drop in quality on screen. The tool opens already configured to that preset.',
	},
	{
		tool: 'compressor',
		slug: 'compress-image-for-web',
		title: 'Compress Image for Web',
		h1: 'Compress Image for Web',
		description:
			'Optimize images for webpages and faster load times. Loads set to the Medium (~70% quality) preset. Free, 100% client-side, no upload.',
		presetQuality: 70,
		presetLabel: 'Medium — ~70%',
		copy: 'A web image needs to load fast, not win a print award. The Medium preset (~70% quality) is the sweet spot for most photos — files typically shrink 60–80% with no artifacts you can see at normal viewing distance. The tool loads already set to that preset, so you can drop a hero image in and ship the optimized copy.',
	},
	{
		tool: 'compressor',
		slug: 'compress-image-to-100kb',
		title: 'Compress Image to 100KB',
		h1: 'Compress Image to 100KB',
		description:
			'Compress images down to ~100KB for strict upload portals and thumbnails. Loads set to the Maximum Compression (~10% quality) preset. Free, no upload.',
		presetQuality: 10,
		presetLabel: 'Maximum Compression — ~10%',
		copy: 'Some forms and databases enforce a hard ~100KB ceiling. The Maximum Compression preset (~10% quality) drives a typical JPEG down to that ballpark — visibility drops but the image stays usable as a thumbnail or avatar. The tool opens already on that preset; the live before/after size tells you whether you hit the target.',
	},
	{
		tool: 'compressor',
		slug: 'compress-image-without-losing-quality',
		title: 'Compress Image Without Losing Quality',
		h1: 'Compress Image Without Losing Quality',
		description:
			'Shrink image file size with no visible quality loss. Loads set to the High Quality (~90% quality) preset. Free, 100% client-side, no upload.',
		presetQuality: 90,
		presetLabel: 'High Quality — ~90%',
		copy: '"Compress without losing quality" really means "drop file size where the eye can\'t tell." The High Quality preset (~90%) re-encodes at a level indistinguishable from the original at normal viewing distance, while still trimming bytes the encoder was wasting. The tool loads already set to that preset — re-save your image leaner without the visible cost.',
	},
];
