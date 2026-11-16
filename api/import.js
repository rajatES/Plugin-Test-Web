import { json, tester } from "./_lib.js";

const HOSTS = new Set(["essentiallysports.com", "www.essentiallysports.com"]);
const KEEP = new Set(["p", "h2", "h3", "h4", "ul", "ol", "li", "strong", "b", "em", "i", "blockquote", "figure", "figcaption", "img", "table", "thead", "tbody", "tr", "th", "td", "q", "br"]);

function escText(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s) {
  return escText(s).replace(/"/g, "&quot;");
}

function render(node) {
  if (!node || typeof node !== "object") {
    return "";
  }
  if (node.type === "text") {
    return escText(node.data);
  }
  const name = node.name;
  const inner = (node.children || []).map(render).join("");
  if (!KEEP.has(name)) {
    return inner;
  }
  if (name === "img") {
    const a = node.attribs || {};
    const src = /^https:\/\//.test(a.src || "") ? a.src : "";
    return src ? `<img src="${escAttr(src)}" alt="${escAttr(a.alt || "")}"/>` : "";
  }
  if (name === "br") {
    return "<br/>";
  }
  return `<${name}>${inner}</${name}>`;
}

async function fetchPage(url) {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0 (Stats Enhancer test site)" }, redirect: "manual" });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      const next = new URL(r.headers.get("location"), target);
      if (next.protocol !== "https:" || !HOSTS.has(next.hostname)) {
        throw new Error("That link redirects outside essentiallysports.com.");
      }
      target = next.toString();
      continue;
    }
    if (!r.ok) {
      throw new Error(`essentiallysports.com answered HTTP ${r.status} for that link.`);
    }
    return r.text();
  }
  throw new Error("Too many redirects.");
}

export async function GET(request) {
  if (!tester(request)) {
    return json({ error: "Sign in first." }, 401);
  }
  const raw = new URL(request.url).searchParams.get("url") || "";
  let target;
  try {
    target = new URL(raw.trim());
  } catch {
    return json({ error: "That isn't a link. Paste the full article address." }, 400);
  }
  if (target.protocol !== "https:" || !HOSTS.has(target.hostname)) {
    return json({ error: "Only essentiallysports.com article links can be imported. For anything else, paste the text into the editor." }, 400);
  }
  try {
    const html = await fetchPage(target.toString());
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      return json({ error: "Couldn't read that page as an article." }, 422);
    }
    const props = JSON.parse(m[1]).props.pageProps;
    const v = props.visualData || {};
    const title = ((v.articleHeadProps || {}).title || "").replace(/\s+/g, " ").trim();
    const content = ((v.articleBodyProps || {}).body || []).map(render).join("");
    if (!content.replace(/<[^>]*>/g, "").trim()) {
      return json({ error: "That page has no article text." }, 422);
    }
    const app = props._appData || {};
    const ts = app.publishedTimestamp;
    const split = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
    return json({
      title,
      content,
      date: ts ? new Date(ts).toISOString().slice(0, 10) : null,
      categories: split(app.categoryNames),
      tags: split(app.tagNames),
      url: target.toString(),
    });
  } catch (e) {
    return json({ error: e.message || "Import failed." }, 502);
  }
}
