// Served through SSR rather than from public/ so it can carry CORS headers:
// @astrojs/node's standalone server streams public/ files straight from disk
// (static handler runs before the app handler), so middleware never sees them
// and Lampa's XHR from its own origin gets blocked. The plugin source is
// public, non-sensitive JS whose whole job is to be loaded cross-origin, so
// the allowance here is unconditional - the API routes it then calls stay
// gated behind CORS_ORIGINS (see middleware.ts).
import source from "../../plugins/scrob.js?raw";

export const GET = () =>
  new Response(source, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
