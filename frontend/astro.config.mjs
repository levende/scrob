// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import node from '@astrojs/node';

// https://astro.build/config
export default defineConfig({
  output: 'server',

  security: {
    checkOrigin: false,
  },

  server: {
    port: 7330,
  },

  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts: ['abstract-dev.bellamylab.com', 'scrob-dev.bellamylab.com'],
      // Dev only - the built server never runs Vite. Vite answers OPTIONS
      // itself, before Astro's middleware ever sees the request, and since
      // Vite 6 its default reflects only localhost origins: a preflight from
      // a LAN device (a Lampa install) came back 204 with no
      // Access-Control-Allow-Origin, so the real request never followed.
      cors: true,
    }
  },

  adapter: node({
    mode: 'standalone'
  })
});