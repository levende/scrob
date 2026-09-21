// Smoke check for the middleware auth gate and its CORS handling.
//
// These three concerns only ever misbehave together - a credential the gate
// does not recognise, a response that leaves through an early return, or a
// redirect where an API caller expects a status - and none of them are
// visible from the source alone, so this drives the real built server.
//
//   npm run build && npm run smoke:gate
//
// The backend must NOT be running: a 502 is how we tell "the gate let this
// through and the proxy tried to forward it" apart from the gate's own 401.

import { spawn } from "node:child_process";
import { once } from "node:events";

const ENTRY = "dist/server/entry.mjs";
const LAMPA = "http://192.168.0.20:9118";
const BACKEND_PORT = process.env.BACKEND_PORT ?? "7331";

let failures = 0;
let checks = 0;

function expect(name, actual, wanted) {
  checks++;
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n         expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`}`);
}

async function withServer(env, fn) {
  const port = 4410 + Math.floor(Math.random() * 80);
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try {
        await fetch(`${base}/plugins/scrob.js`, { redirect: "manual" });
        break;
      } catch (e) {
        if (i > 100) throw new Error(`server never came up on ${port}: ${e.message}`);
        await new Promise(r => setTimeout(r, 100));
      }
    }
    await fn((path, init) => fetch(base + path, { redirect: "manual", ...init }));
  } finally {
    child.kill();
    await once(child, "exit");
  }
}

// A backend answering on 7331 would turn the pass-through cases into real
// backend responses and the 502 assertions would be meaningless.
try {
  await fetch(`http://localhost:${BACKEND_PORT}/`, { signal: AbortSignal.timeout(500) });
  console.error(`Backend is running on ${BACKEND_PORT}. Stop it and re-run: this check needs the proxy's fetch to fail.`);
  process.exit(2);
} catch {
  // expected
}

console.log("\nCORS_ORIGINS unset - the behaviour every install had before CORS existed");
await withServer({ CORS_ORIGINS: "" }, async get => {
  const plugin = await get("/plugins/scrob.js", { headers: { Origin: LAMPA } });
  expect("plugin file is loadable cross-origin regardless of config", plugin.status, 200);
  expect("plugin file carries ACAO", plugin.headers.get("access-control-allow-origin"), "*");

  const me = await get("/api/proxy/auth/me", { headers: { Origin: LAMPA, Authorization: "Bearer x" } });
  expect("no CORS headers on the proxy when unconfigured", me.headers.get("access-control-allow-origin"), null);

  const proxy = await get("/api/proxy/history");
  expect("same-origin unauthenticated proxy call still redirects", proxy.status, 302);
  expect("...to /login", proxy.headers.get("location"), "/login");

  const page = await get("/history");
  expect("page gate unchanged", page.status, 302);
});

console.log('\nCORS_ORIGINS="*"');
await withServer({ CORS_ORIGINS: "*" }, async get => {
  const pre = await get("/api/proxy/auth/login", {
    method: "OPTIONS",
    headers: { Origin: LAMPA, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-api-key" },
  });
  expect("preflight is answered before the auth gate", pre.status, 204);
  expect("preflight ACAO", pre.headers.get("access-control-allow-origin"), "*");
  expect("preflight allows X-Api-Key", pre.headers.get("access-control-allow-headers")?.includes("X-Api-Key"), true);
  expect("preflight allows POST", pre.headers.get("access-control-allow-methods")?.includes("POST"), true);
  expect("credentials are never allowed", pre.headers.get("access-control-allow-credentials"), null);

  // 502 = the gate let it through and the proxy tried to reach the backend.
  const login = await get("/api/proxy/auth/login", { method: "POST", headers: { Origin: LAMPA }, body: "grant_type=password" });
  expect("login needs no credential (it is how you get one)", login.status, 502);
  expect("login response carries ACAO", login.headers.get("access-control-allow-origin"), "*");

  for (const [name, init] of [
    ["Bearer JWT", { headers: { Origin: LAMPA, Authorization: "Bearer x" } }],
    ["X-Api-Key header", { headers: { Origin: LAMPA, "X-Api-Key": "x" } }],
  ]) {
    const res = await get("/api/proxy/auth/me", init);
    expect(`gate forwards a ${name}`, res.status, 502);
  }
  for (const [name, path] of [
    ["?api_key=", "/api/proxy/auth/me?api_key=x"],
    ["?token=", "/api/proxy/auth/me?token=x"],
  ]) {
    const res = await get(path, { headers: { Origin: LAMPA } });
    expect(`gate forwards a ${name} query param`, res.status, 502);
  }

  const denied = await get("/api/proxy/history", { headers: { Origin: LAMPA } });
  expect("credential-less API call gets 401, not a redirect to HTML", denied.status, 401);
  expect("...and still carries ACAO, so the client sees the real error", denied.headers.get("access-control-allow-origin"), "*");
});

console.log("\nCORS_ORIGINS=<allowlist>");
await withServer({ CORS_ORIGINS: `${LAMPA}, http://other.example` }, async get => {
  const allowed = await get("/api/proxy/history", { headers: { Origin: LAMPA } });
  expect("listed origin is echoed back", allowed.headers.get("access-control-allow-origin"), LAMPA);
  expect("...with Vary, so a cache cannot cross-serve it", allowed.headers.get("vary"), "Origin");

  const other = await get("/api/proxy/history", { headers: { Origin: "http://evil.example" } });
  expect("unlisted origin gets nothing", other.headers.get("access-control-allow-origin"), null);
});

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
