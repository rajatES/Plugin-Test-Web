import { env, json, tester } from "./_lib.js";

const TEXT_FIELDS = ["kicker", "headline", "headline_accent", "subhead", "caption", "alt"];

function ok(data) {
  return json({ success: true, data });
}

function fail(message, status = 200) {
  return json({ success: false, data: { message } }, status);
}

function list(value) {
  return String(value || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
}

async function call(action, payload, timeoutMs) {
  const url = env("STATS_ENHANCER_URL");
  const token = env("STATS_ENHANCER_TOKEN");
  if (!url || !token) {
    throw new Error("The test site is not connected to the Stats Enhancer service yet.");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": token },
      body: JSON.stringify({ action, ...payload }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`The service returned an unreadable response (HTTP ${r.status}).`);
    }
    if (r.status >= 400) {
      throw new Error(body.error || `The service returned HTTP ${r.status}.`);
    }
    return body;
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("The service took too long to answer. Try again.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

export async function POST(request) {
  const who = tester(request);
  if (!who) {
    return fail("Your tester session has ended. Reload the page and sign in again.", 401);
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return fail("Bad request.", 400);
  }
  const action = String(form.get("action") || "").replace(/^stats_enhancer_/, "");
  const postId = String(form.get("post_id") || "draft").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "draft";
  const jobId = String(form.get("job_id") || "");
  const addonId = String(form.get("addon_id") || "");
  try {
    if (action === "start") {
      const content = String(form.get("content") || "");
      if (!content.replace(/<[^>]*>/g, "").trim()) {
        return fail("The article is empty.");
      }
      const date = String(form.get("date") || "");
      const r = await call("start", {
        title: String(form.get("title") || "").slice(0, 300),
        content: content.slice(0, 200000),
        date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date : new Date().toISOString().slice(0, 10),
        categories: list(form.get("categories")),
        tags: list(form.get("tags")),
        post_id: `test-${postId}`,
        site: "stats-enhancer-test-site",
        user: who,
        fresh: Boolean(form.get("fresh")),
      }, 30000);
      if (!r.job_id) {
        return fail(r.error || "The service did not start a job.");
      }
      log("start", { tester: who, job: r.job_id, reused: Boolean(r.reused), post: postId });
      return ok({ job_id: r.job_id, reused: Boolean(r.reused) });
    }
    if (action === "status") {
      if (!jobId) {
        return fail("No job.");
      }
      return ok(await call("status", { job_id: jobId }, 20000));
    }
    if (action === "render") {
      let text = {};
      try {
        text = JSON.parse(String(form.get("text") || "{}"));
      } catch {
        text = {};
      }
      const clean = {};
      for (const k of TEXT_FIELDS) {
        if (typeof text[k] === "string") {
          clean[k] = text[k].slice(0, 400);
        }
      }
      log("render", { tester: who, job: jobId, addon: addonId });
      return ok(await call("render", { job_id: jobId, addon_id: addonId, text: clean }, 55000));
    }
    if (action === "insert_image") {
      const st = await call("status", { job_id: jobId }, 20000);
      const addon = (st.addons || []).find((a) => a.id === addonId);
      if (!addon) {
        return fail("That add-on is no longer available. Run the tool again.");
      }
      const img = addon.image || {};
      if (!/^https:\/\//.test(img.url || "")) {
        return fail("This add-on has no downloadable image.");
      }
      log("insert", { tester: who, job: jobId, addon: addonId, template: addon.template });
      return ok({ id: Date.now() % 1000000, url: img.url, full: img.url, width: img.width || null, height: img.height || null });
    }
    if (action === "log_insert") {
      log("insert", { tester: who, job: jobId, addon: addonId, template: String(form.get("template") || "") });
      return ok({});
    }
    return fail("Unknown action.", 400);
  } catch (e) {
    log("error", { tester: who, action, job: jobId, message: String(e.message || e).slice(0, 300) });
    return fail(e.message || "Request failed.");
  }
}
