/**
 * Programmatic-SEO use-case data for the Image Resizer.
 *
 * Each entry powers one landing page at browserpixels.com/[slug], generated via
 * getStaticPaths in src/pages/[slug].astro. The page leans on the existing
 * ImageResizer component — the data here just pre-configures it to the exact
 * dimensions the long-tail keyword targets (e.g. "resize image for instagram"
 * → 1080×1080), and supplies page-level SEO copy (title, description, H1,
 * JSON-LD).
 *
 * `presetMode` mirrors the component's modes:
 *   - 'exact'   → dimensions mode with specific width/height (aspect unlocked
 *                 so a square target forces a square crop even from a wide
 *                 source, e.g. a Discord emoji must be 128×128 exactly).
 *   - 'percent' → percentage scale, uses presetPercent instead.
 *
 * Keep slugs lowercase-hyphenated and aligned to the search query they target.
 */

export type ResizePresetMode = 'exact' | 'percent';

export interface ResizeUseCase {
	/** Discriminator telling [slug].astro which React component to render. */
	tool: 'resizer';
	slug: string;
	/** <title> text for the page. Keep under ~60 chars. */
	title: string;
	/** Visible H1. */
	h1: string;
	/** Meta description — keep under ~155 chars. */
	description: string;
	presetMode: ResizePresetMode;
	/** Target width in px (exact mode). */
	presetWidth?: number;
	/** Target height in px (exact mode). */
	presetHeight?: number;
	/** Percent scale (percent mode). */
	presetPercent?: number;
	/** Body copy paragraph shown under the tool. */
	copy: string;
}

export const resizeUseCases: ResizeUseCase[] = [
	{
		tool: 'resizer',
		slug: 'resize-image-for-instagram',
		title: 'Resize Image for Instagram',
		h1: 'Resize Image for Instagram (1080 x 1080)',
		description:
			"Instantly resize your photos to Instagram's exact specifications (1080x1080 for feed, 1080x1920 for stories). Free, no upload.",
		presetMode: 'exact',
		presetWidth: 1080,
		presetHeight: 1080,
		copy: 'Instagram requires specific dimensions for posts and stories. If your image is too large, it crops awkwardly. Our tool automatically sets your image to 1080x1080 so it fits perfectly in your feed.',
	},
	{
		tool: 'resizer',
		slug: 'resize-image-for-discord-emoji',
		title: 'Resize Image for Discord Emoji',
		h1: 'Resize Image for Discord Emoji (128 x 128)',
		description:
			'Make a Discord emoji from any photo. Resize to 128x128 instantly in your browser.',
		presetMode: 'exact',
		presetWidth: 128,
		presetHeight: 128,
		copy: 'Discord emojis must be exactly 128x128 pixels. Upload your image, and our tool will automatically apply the 128x128 preset so you can download it and upload it straight to your Discord server.',
	},
	{
		tool: 'resizer',
		slug: 'resize-image-for-twitter',
		title: 'Resize Image for Twitter / X',
		h1: 'Resize Image for Twitter / X (1600 x 900)',
		description:
			'Resize photos for Twitter / X posts and banners. Set your image to 1600x900 instantly in your browser, free.',
		presetMode: 'exact',
		presetWidth: 1600,
		presetHeight: 900,
		copy: 'Twitter / X renders single-image posts at a 16:9 ratio. Uploading an image already sized to 1600x900 means it shows full-width in the timeline without cropping or compression surprises. Drop your photo and the tool loads pre-set to 1600x900.',
	},
	{
		tool: 'resizer',
		slug: 'resize-image-to-1920x1080',
		title: 'Resize Image to 1920x1080 (HD Wallpaper)',
		h1: 'Resize Image to 1920 x 1080 (HD Wallpaper)',
		description:
			'Turn any photo into a 1920x1080 HD desktop wallpaper. Resize to 1080p instantly in your browser, free and private.',
		presetMode: 'exact',
		presetWidth: 1920,
		presetHeight: 1080,
		copy: 'A full-HD desktop wallpaper is 1920x1080 pixels. Our tool loads pre-configured to exactly that size, so you can drop in your photo and download a wallpaper-resolution image ready for a 1080p monitor.',
	},
	{
		tool: 'resizer',
		slug: 'resize-image-for-email',
		title: 'Resize Image for Email',
		h1: 'Resize Image for Email (Scale Down 50%)',
		description:
			'Shrink photos for email attachments so they actually send. Scale images down 50% instantly in your browser, free.',
		presetMode: 'percent',
		presetPercent: 50,
		copy: 'Email providers reject attachments that are too large, and oversized inline images take forever to load. Scaling an image down to 50% of its original dimensions is a reliable way to cut the file size enough for it to sail through. Load a photo and the tool is already set to a 50% scale.',
	},
];
