/**
 * Programmatic-SEO use-case data for the EXIF / metadata stripper.
 *
 * Each entry powers one landing page at browserpixels.com/[slug], generated via
 * getStaticPaths in src/pages/[slug].astro. Unlike the resizer and compressor,
 * the EXIF tool has no sliders or dimension inputs — it nukes all metadata the
 * same way every time — so these pages carry no preset props. The data here
 * just supplies page-level SEO copy (title, description, H1, JSON-LD) tuned to
 * the long-tail query each slug targets, and the page renders the existing
 * MetadataStripper component untouched.
 *
 * Keep slugs lowercase-hyphenated and aligned to the search query they target.
 */

export interface ExifUseCase {
	/** Discriminator telling [slug].astro which React component to render. */
	tool: 'exif';
	slug: string;
	/** <title> text for the page. Keep under ~60 chars. */
	title: string;
	/** Visible H1. */
	h1: string;
	/** Meta description — keep under ~155 chars. */
	description: string;
	/** Body copy paragraph shown under the tool. */
	copy: string;
}

export const exifUseCases: ExifUseCase[] = [
	{
		tool: 'exif',
		slug: 'remove-gps-data-from-photos',
		title: 'Remove GPS Data from Photos',
		h1: 'Remove GPS Data from Photos',
		description:
			'Strip the hidden GPS coordinates from your photos before you post or share them. Free, 100% in-browser, no upload — your location never leaves your device.',
		copy: 'When location services are on, your phone embeds the exact latitude and longitude of where each photo was taken into the file as EXIF data — invisible in the image, but readable by anyone who has the file. A photo shared to a forum, marketplace, or as a direct file can quietly leak your home or workplace. Drop your photo in and the tool scans it locally, shows you the GPS data it found, and produces a cleaned copy with the coordinates stripped out. Nothing is uploaded, and the pixels are never re-encoded, so there is zero quality loss.',
	},
	{
		tool: 'exif',
		slug: 'strip-exif-from-jpg',
		title: 'Strip EXIF Data from JPG',
		h1: 'Strip EXIF Data from JPG',
		description:
			'Remove all EXIF metadata from JPG files — camera model, date, GPS, software history. Byte-level removal, no re-encoding, 100% client-side, free.',
		copy: 'JPG is the most metadata-heavy format your camera or phone produces. Every shot carries the camera make and model, the exact date and time, lens and exposure settings, and often GPS coordinates. This tool parses the JPG file at the byte level, strips the EXIF, XMP, and IPTC segments along with any comment markers, and writes out a clean file with every pixel byte untouched. No canvas re-encoding means no recompression and no quality loss — just the tracking data gone.',
	},
	{
		tool: 'exif',
		slug: 'remove-metadata-from-png',
		title: 'Remove Metadata from PNG',
		h1: 'Remove Metadata from PNG',
		description:
			'Strip text, EXIF, and time chunks from PNG files. Byte-level removal, no re-encoding or quality loss, 100% client-side and free.',
		copy: 'PNG embeds metadata differently than JPG — it tucks it into text chunks (tEXt, iTXt, zTXt), an optional eXIf chunk, and a tIME chunk marking the last edit. Software like Photoshop, Lightroom, and many screen-recording and export tools write author, copyright, and editing-history fields into these chunks. This tool reads the PNG chunk structure, drops the metadata-bearing chunks, and copies the rest through unchanged. The image data is untouched, so exported PNGs keep their exact pixels and transparency.',
	},
	{
		tool: 'exif',
		slug: 'remove-location-data-from-iphone-photos',
		title: 'Remove Location Data from iPhone Photos',
		h1: 'Remove Location Data from iPhone Photos',
		description:
			'Clear the hidden GPS location your iPhone bakes into every photo. Free, in-browser, no upload — scrub coordinates before you share.',
		copy: 'iPhones tag every photo with precise GPS coordinates the moment it is taken, plus the device model, software version, and capture settings. Even when you AirDrop or "send as file" a picture, that location rides along inside it. This tool is built for exactly that case: drop one or several iPhone photos in and each is scanned on your device, with the embedded location surfaced as a tag so you can confirm what was there, then stripped to a clean downloadable copy. Because it runs locally, your phone\'s location data is never sent to a server.',
	},
	{
		tool: 'exif',
		slug: 'scrub-camera-data-from-webp',
		title: 'Scrub Camera Data from WebP',
		h1: 'Scrub Camera Data from WebP',
		description:
			'Remove EXIF and XMP chunks from WebP files before serving them on the web. Byte-level, no re-encoding, 100% client-side and free.',
		copy: 'WebP files can carry EXIF and XMP metadata inside their RIFF container — camera data, software fingerprints, and sometimes location — that your users can pull with a single command. If you serve user-generated or camera-exported WebP images, that metadata is a privacy leak and dead bytes you are shipping over the wire. This tool reads the WebP RIFF chunk structure, removes the EXIF and XMP chunks, and writes out a leaner file with the image data bit-for-bit identical and the file size a few bytes lighter.',
	},
];
