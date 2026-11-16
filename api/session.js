import { clearCookie, json, makeCookie, tester, testers } from "./_lib.js";

export async function GET(request) {
  const name = tester(request);
  return json({ signedIn: Boolean(name), name: name || null });
}

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const code = String(body.code || "").trim();
  const name = code ? testers().get(code) : null;
  if (!name) {
    await new Promise((r) => setTimeout(r, 700));
    return json({ error: "That code isn't valid. Check it and try again." }, 401);
  }
  console.log(JSON.stringify({ event: "sign_in", tester: name }));
  return json({ signedIn: true, name }, 200, { "Set-Cookie": makeCookie(name) });
}

export async function DELETE() {
  return json({ signedIn: false }, 200, { "Set-Cookie": clearCookie() });
}
