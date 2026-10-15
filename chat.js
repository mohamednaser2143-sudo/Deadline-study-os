// Vercel Serverless Function: /api/chat
// Set GROQ_API_KEY in Vercel Project Settings > Environment Variables.
// Optional: set GROQ_MODEL to another model available to your Groq account.

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 20;
const requestLog = new Map();

function getClientKey(req) {
  // Vercel supplies x-forwarded-for. This is best-effort protection, not a substitute
  // for a durable rate limiter if the site becomes popular.
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") || "unknown";
  return ip.slice(0, 100);
}

function isRateLimited(key) {
  const now = Date.now();
  for (const [ip, timestamps] of requestLog.entries()) {
    const fresh = timestamps.filter((time) => now - time < WINDOW_MS);
    if (fresh.length) requestLog.set(ip, fresh);
    else requestLog.delete(ip);
  }

  const timestamps = (requestLog.get(key) || []).filter((time) => now - time < WINDOW_MS);
  if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    requestLog.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  requestLog.set(key, timestamps);
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST to send a chat message." });
  }

  if (isRateLimited(getClientKey(req))) {
    return res.status(429).json({ error: "Too many questions too quickly. Please wait a minute and try again." });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "The AI is not configured yet. The site owner needs to add GROQ_API_KEY in Vercel and redeploy."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }

  if (!body || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: "Invalid chat request." });
  }

  const incoming = body.messages.slice(-12);
  let totalChars = 0;
  const messages = [];

  for (const message of incoming) {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      return res.status(400).json({ error: "One of the chat messages is invalid." });
    }
    const content = message.content.trim();
    if (!content || content.length > 4000) {
      return res.status(400).json({ error: "Each message must contain between 1 and 4,000 characters." });
    }
    totalChars += content.length;
    messages.push({ role: message.role, content });
  }

  if (!messages.length || messages[messages.length - 1].role !== "user" || totalChars > 12000) {
    return res.status(400).json({ error: "Please send a valid question and keep the recent conversation shorter." });
  }

  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const systemPrompt = [
    "You are DeadlineOS AI, a helpful, patient study assistant inside a student productivity website.",
    "Answer general questions, explain math and coding clearly, and help with schoolwork.",
    "When solving a problem, show understandable steps and explain why they work.",
    "Use clear plain text, numbered steps, and concise answers. If you are unsure, say so rather than inventing facts.",
    "Be friendly and age-appropriate. Help students understand rather than just encouraging them to copy answers.",
    "You may offer study-planning advice, but do not claim you can see the user's assignments unless they share them in the chat."
  ].join(" ");

  try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        temperature: 0.5,
        max_tokens: 900
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      // Log status only; never log the API key or full authorization headers.
      console.error("Groq API request failed with status:", upstream.status);
      if (upstream.status === 401 || upstream.status === 403) {
        return res.status(502).json({ error: "Groq rejected the API key. Check GROQ_API_KEY in Vercel." });
      }
      if (upstream.status === 429) {
        return res.status(429).json({ error: "The AI is busy or the Groq usage limit was reached. Please wait and try again." });
      }
      if (upstream.status === 400) {
        return res.status(502).json({ error: "The selected Groq model may be unavailable. Check GROQ_MODEL in Vercel." });
      }
      return res.status(502).json({ error: "Groq could not answer right now. Please try again later." });
    }

    const reply = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;

    if (typeof reply !== "string" || !reply.trim()) {
      return res.status(502).json({ error: "Groq returned no answer. Please try again." });
    }

    return res.status(200).json({ reply: reply.trim() });
  } catch (error) {
    console.error("Chat endpoint network error:", error && error.name ? error.name : "UnknownError");
    return res.status(502).json({ error: "Could not connect to the AI service. Please try again later." });
  }
};
