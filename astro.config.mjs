// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	// Canonical origin used by the sitemap and (via the Layout's SITE const
	// mirroring this) JSON-LD / canonical tags. Keep in sync with SITE in
	// src/layouts/Layout.astro.
	site: 'https://browserpixels.com',
	integrations: [react(), sitemap()],
	vite: {
		plugins: [tailwindcss()],
	},
});
