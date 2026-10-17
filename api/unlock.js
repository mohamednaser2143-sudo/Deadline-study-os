// Vercel Serverless Function: /api/unlock
// Set SITE_PASSWORD in Vercel Project Settings > Environment Variables.
// The password is checked here so it never appears in the page source.

const crypto = require("crypto");

const WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 10;
const attemptLog = new Map();

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") || "unknown";
  return ip.slice(0, 100);
}

function isRateLimited(key) {
  const now = Date.now();
  for (const [ip, timestamps] of attemptLog.entries()) {
    const fresh = timestamps.filter((time) => now - time < WINDOW_MS);
    if (fresh.length) attemptLog.set(ip, fresh);
    else attemptLog.delete(ip);
  }

  const timestamps = (attemptLog.get(key) || []).filter((time) => now - time < WINDOW_MS);
  if (timestamps.length >= MAX_ATTEMPTS_PER_WINDOW) {
    attemptLog.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  attemptLog.set(key, timestamps);
  return false;
}

function safeEqual(a, b) {
  // Hash both sides so the comparison is constant-time regardless of length.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST to unlock." });
  }

  if (isRateLimited(getClientKey(req))) {
    return res.status(429).json({ error: "Too many attempts. Please wait a minute and try again." });
  }

  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword) {
    return res.status(500).json({
      error: "No password is set yet. The site owner needs to add SITE_PASSWORD in Vercel and redeploy."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }

  const password = body && typeof body.password === "string" ? body.password : "";
  if (!password || password.length > 200 || !safeEqual(password, sitePassword)) {
    return res.status(401).json({ error: "Wrong password. Try again." });
  }

  return res.status(200).json({ ok: true });
};
