import { defineMiddleware } from "astro:middleware";
import { api } from "./lib/api";

const PUBLIC_ROUTES = ["/login", "/register", "/logout", "/oidc-callback", "/oidc-start", "/link", "/site.webmanifest", "/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/sw.js", "/offline.html"];
// /api/proxy/auth/device/code and /device/token are the RFC 8628 endpoints a
// third-party client hits with no Scrob session at all (#331) — the backend
// leaves them unauthenticated by design, so the cookie gate must let them
// through. Approve/pending/grants are NOT listed: those require a real login.
// /api/proxy/auth/login is public for the same reason: it is the only way an
// external client (the Lampa plugin) can exchange a password for a token, and
// requiring an API key to get one is circular. It exposes nothing new - the
// /login page is public and hands the same credentials to the same backend
// endpoint, which rate-limits at 10/minute.
const PUBLIC_PREFIXES = ["/auth/activate/", "/forgot-password", "/reset-password/", "/api/proxy/webhooks/", "/api/proxy/auth/has-users", "/api/proxy/auth/bootstrap-restore", "/api/proxy/auth/device/code", "/api/proxy/auth/device/token", "/api/proxy/auth/login", "/api/proxy/media/stream/", "/api/proxy/radarr-compat/", "/api/proxy/sonarr-compat/"];
// Matches /profile/{id} (someone else's public profile page) but not the bare
// /profile page (the logged-in user's own profile management), which must stay gated.
const PUBLIC_PROFILE_PAGE_RE = /^\/profile\/\d+\/?$/;
// The profile page's <img> tag hits this proxy path directly. It has no file
// extension, so it doesn't fall under isStaticAsset below like TMDB poster
// URLs do, and needs the same admin-gated anonymous allowance as the page itself.
const PUBLIC_AVATAR_PROXY_RE = /^\/api\/proxy\/profile\/avatar\/\d+$/;
// Matches /list/{id} (someone else's public/friends-only list page). The list
// itself still enforces its own privacy_level server-side; this only decides
// whether a logged-out visitor gets past the gate at all.
const PUBLIC_LIST_PAGE_RE = /^\/list\/\d+\/?$/;
// The profile page's "See All" links for Top Rated Movies/Shows and Recently
// Watched Movies/Shows - same privacy model as PUBLIC_PROFILE_PAGE_RE above
// (the endpoint re-checks privacy itself).
const PUBLIC_TOP_RATED_PAGE_RE = /^\/top-rated-(?:movies|shows)\/\d+\/?$/;
const PUBLIC_RECENTLY_WATCHED_PAGE_RE = /^\/recently-watched-(?:movies|shows)\/\d+\/?$/;
// The read-only browse pages, allowed anonymously only when the admin has
// enabled logged-out navigation (Admin Settings) and a global TMDB key is set.
const PUBLIC_EXPLORE_PAGE_RE = /^\/(?:(?:movies|shows|search|lists|airing-today|discover)?|trending\/(?:movies|shows))\/?$/;
// Movie/episode and show/season/episode detail pages (TMDB- and TVDB-numbered
// variants), gated the same way as PUBLIC_EXPLORE_PAGE_RE above.
const PUBLIC_MEDIA_DETAIL_PAGE_RE =
  /^\/(?:media\/(?:movie|episode)\/\d+|show\/(?:tvdb\/)?\d+(?:\/season\/\d+(?:\/\d+)?)?|person\/\d+|network\/\d+|studio\/\d+)\/?$/;
// The detail pages' "More like this" row and the person page's credits
// pagination are loaded client-side from these partials - same admin+
// global-key gate as the pages above, otherwise an anonymous fetch() here
// gets redirected to /login and its HTML gets injected into the page
// (fetch() follows redirects, so it looks like a normal 200 response).
const PUBLIC_RECOMMENDATIONS_PARTIAL_RE = /^\/partials\/recommendations\/?$/;
const PUBLIC_PERSON_CREDITS_PARTIAL_RE = /^\/partials\/person-credits\/?$/;
// The homepage's and /discover's data rows are loaded client-side straight
// from the backend proxy (not a same-origin partial), so the proxy path
// itself needs the same allowance - otherwise the fetch() gets redirected to
// /login and the section silently disappears (JSON.parse on the login page's
// HTML throws, caught by each row's own error handling).
const PUBLIC_MEDIA_ROWS_PROXY_RE =
  /^\/api\/proxy\/media\/(trending\/(movies|shows|trailers)|airing-today\/collected|on-air-today|now-playing|upcoming|top-rated-(movies|shows)|on-air-this-week|hidden-gems|streaming)\/?$/;
// API docs reveal the full endpoint surface and exact app version - admin-only,
// never public, regardless of the isStaticAsset check below (which would
// otherwise treat /openapi.json as a public static file just from its extension).
const ADMIN_ONLY_ROUTES = ["/docs", "/redoc", "/openapi.json"];

// Security headers added to every response.
// CSP is intentionally omitted — Astro's define:vars emits inline <script>
// blocks whose hashes change every build, making a static policy impractical.
const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Cross-origin access to the backend proxy, for external clients that talk to
// Scrob from another origin (the Lampa plugin fetches /api/proxy/* from Lampa's
// own page). Unset => no CORS headers at all, i.e. same-origin only, which is
// what every install did before this existed. "*" allows any origin; otherwise
// only the listed origins are echoed back.
//
// Credentials are deliberately never allowed: auth on these routes is
// header-based (X-Api-Key / Bearer), and letting the session cookie ride along
// cross-origin would turn any page the user visits into an authenticated client.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (!origin || CORS_ORIGINS.length === 0) return null;
  if (CORS_ORIGINS.includes("*")) return "*";
  return CORS_ORIGINS.includes(origin) ? origin : null;
}

function corsHeaders(origin: string, preflight: boolean): Record<string, string> {
  const headers: Record<string, string> = { "Access-Control-Allow-Origin": origin };
  // Without this a cache (or the browser) can serve one origin's response to
  // another origin, since the body is identical but the header is not.
  if (origin !== "*") headers["Vary"] = "Origin";
  if (preflight) {
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Api-Key";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const token = context.cookies.get("token")?.value;
  const { pathname } = context.url;

  // Answered before the auth gate below: a preflight carries neither cookie
  // nor API key, so the gate would 302 it to /login and the browser would
  // read that as a failed preflight and never send the real request.
  const corsOrigin = pathname.startsWith("/api/proxy/") ? allowedOrigin(context.request) : null;
  if (corsOrigin && context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(corsOrigin, true) });
  }

  // Every response leaves through here, including the early returns below -
  // a redirect that skips the CORS headers reads to the browser as a plain
  // "no Access-Control-Allow-Origin" failure, hiding the actual reason.
  const finish = (response: Response) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(header, value);
    }
    if (corsOrigin) {
      for (const [header, value] of Object.entries(corsHeaders(corsOrigin, false))) {
        response.headers.set(header, value);
      }
    }
    return response;
  };

  // A cross-origin API caller gets a real 401 instead of a 302 to the HTML
  // login page: XHR follows redirects, and /login is not an API route and
  // carries no CORS headers, so the client would still end up with an opaque
  // CORS error rather than "not authenticated".
  const denied = () =>
    corsOrigin
      ? finish(
          new Response(JSON.stringify({ detail: "Not authenticated" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
        )
      : context.redirect("/login", 302);

  // This gate is a session redirector for the browser UI, not the
  // authorization check. Any request to the backend proxy that carries a
  // credential the proxy forwards goes straight through, and the backend's
  // own per-endpoint dependency decides whether it is accepted.
  //
  // All four forms the proxy understands are listed, because listing only
  // some of them locks out clients the backend would happily serve:
  //   Authorization  the Bearer JWT the backend itself issues, and the
  //                  credential every non-browser client uses after login
  //                  (backend get_current_user)
  //   X-Api-Key      the per-user key accepted as an alternative to a JWT
  //                  (backend get_current_user_or_api_key)
  //   ?api_key=      the same key as a query param, for <img> and the like
  //   ?token=        a JWT as a query param, for elements that cannot set
  //                  headers (<video>); the proxy turns it back into an
  //                  Authorization header
  const hasForwardedCredential =
    pathname.startsWith("/api/proxy/") &&
    (context.request.headers.has("Authorization") ||
      context.request.headers.has("X-Api-Key") ||
      context.url.searchParams.has("api_key") ||
      context.url.searchParams.has("token"));

  // Skip auth for static assets and public routes
  const isStaticAsset = /\.(js|css|woff2?|ico|png|svg|webp|jpg|jpeg|webmanifest|json|xml)$/.test(pathname);
  const isAdminOnlyRoute = ADMIN_ONLY_ROUTES.includes(pathname);
  const isPublicRoute =
    !isAdminOnlyRoute &&
    (hasForwardedCredential || isStaticAsset || PUBLIC_ROUTES.includes(pathname) || PUBLIC_PREFIXES.some(p => pathname.startsWith(p)));

  // Anonymous access to any of these read-only pages is allowed only when the
  // admin has enabled logged-out navigation (Admin Settings) and a global
  // TMDB key is set. Profile/list pages still enforce their own privacy
  // (public/friends/private) server side - this only decides whether a
  // logged-out visitor gets past the gate at all. Fails closed (redirects to
  // login) if the check errors.
  const isAllowedAnonymousPublicPage = async () => {
    const isGatedPage =
      PUBLIC_PROFILE_PAGE_RE.test(pathname) ||
      PUBLIC_AVATAR_PROXY_RE.test(pathname) ||
      PUBLIC_LIST_PAGE_RE.test(pathname) ||
      PUBLIC_TOP_RATED_PAGE_RE.test(pathname) ||
      PUBLIC_RECENTLY_WATCHED_PAGE_RE.test(pathname) ||
      PUBLIC_EXPLORE_PAGE_RE.test(pathname) ||
      PUBLIC_MEDIA_DETAIL_PAGE_RE.test(pathname) ||
      PUBLIC_RECOMMENDATIONS_PARTIAL_RE.test(pathname) ||
      PUBLIC_PERSON_CREDITS_PARTIAL_RE.test(pathname) ||
      PUBLIC_MEDIA_ROWS_PROXY_RE.test(pathname);
    if (!isGatedPage) return false;
    try {
      const status = await api.profile.publicAccessStatus();
      return status.enable_logged_out_navigation;
    } catch {
      return false;
    }
  };

  if (token) {
    try {
      // Verify token and get user info
      const user = await api.auth.me(token);
      context.locals.user = user;
      context.locals.token = token;

      // If logged in and trying to access login/register, redirect to home
      if (pathname === "/login" || pathname === "/register") {
        return context.redirect("/", 302);
      }

      // API docs are admin-only, even for logged-in non-admin users
      if (isAdminOnlyRoute && !user.is_admin) {
        return context.redirect("/", 302);
      }
    } catch (e) {
      // Only clear the session on a genuine auth rejection (bad/expired
      // token). Any other failure here - the backend restarting, a network
      // blip, a timeout - is transient and unrelated to whether this token
      // is valid; clearing the cookie for those silently logs the user out
      // and (now that /movies and /shows are reachable anonymously) does so
      // without even an obvious redirect to explain why. Treat this one
      // request as unauthenticated and let the next request re-verify.
      const isAuthRejected = e instanceof Error && /^API 401\b/.test(e.message);
      if (isAuthRejected) {
        context.cookies.delete("token", { path: "/" });
      }
      if (!isPublicRoute && !(await isAllowedAnonymousPublicPage())) {
        return denied();
      }
    }
  } else {
    // No token, redirect to login if not a public route
    if (!isPublicRoute && !(await isAllowedAnonymousPublicPage())) {
      return denied();
    }
  }

  return finish(await next());
});
