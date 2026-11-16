import crypto from "node:crypto";

export function env(key, fallback = "") {
  return process.env[key] || fallback;
}

function secret() {
  const s = env("SESSION_SECRET");
  if (!s) {
    throw new Error("SESSION_SECRET is not set");
  }
  return s;
}

export function testers() {
  const out = new Map();
  for (const part of env("TESTER_CODES").split(",")) {
    const i = part.indexOf(":");
    if (i < 1) {
      continue;
    }
    const name = part.slice(0, i).trim();
    const code = part.slice(i + 1).trim();
    if (name && code) {
      out.set(code, name);
    }
  }
  return out;
}

function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

export function makeCookie(name, maxAgeS = 60 * 60 * 24 * 14) {
  const payload = Buffer.from(JSON.stringify({ n: name, e: Math.floor(Date.now() / 1000) + maxAgeS })).toString("base64url");
  return `se_tester=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
}

export function clearCookie() {
  return "se_tester=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

export function tester(request) {
  const raw = request.headers.get("cookie") || "";
  const m = raw.match(/(?:^|;\s*)se_tester=([^;]+)/);
  if (!m) {
    return null;
  }
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) {
    return null;
  }
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.n || data.e < Date.now() / 1000) {
      return null;
    }
    const active = new Set(testers().values());
    return active.has(data.n) ? data.n : null;
  } catch {
    return null;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
