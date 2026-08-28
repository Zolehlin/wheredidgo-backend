/**
 * WhereDidItGo? — backend Worker
 * Handles: understanding the query (Google Gemini), real web search (Tavily),
 * and historical snapshots (Wayback Machine — no key needed).
 *
 * SETUP:
 * 1. In Cloudflare dashboard, open this Worker's Settings → Variables and Secrets
 * 2. Add secret: TAVILY_API_KEY  = your Tavily key
 * 3. Add secret: GEMINI_API_KEY = your Google AI Studio key (aistudio.google.com)
 * 4. Deploy
 *
 * Your frontend calls: POST https://<this-worker>.workers.dev/search
 * Body: { "query": "the thing you remember" }
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // DEBUG MODE: visit /search?debug=your+query directly in a browser to test
    if (request.method === "GET" && url.searchParams.get("debug")) {
      const query = url.searchParams.get("debug");
      const debug = {};
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: "Say hello in JSON: {\"msg\":\"...\"}" }] }] }),
          }
        );
        debug.geminiHttpStatus = res.status;
        debug.geminiRawResponse = await res.json();
        debug.geminiKeyPresent = !!env.GEMINI_API_KEY;
        debug.geminiKeyLength = env.GEMINI_API_KEY ? env.GEMINI_API_KEY.length : 0;
      } catch (e) { debug.geminiFetchError = String(e); }

      return json(debug, 200, corsHeaders);
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST (or GET /?debug=your+query to test)" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    try {
      const { query } = await request.json();
      if (!query || typeof query !== "string" || query.trim().length < 3) {
        return json({ error: "Please describe what you remember in more detail." }, 400, corsHeaders);
      }

      const understanding = await understandQuery(query, env.GEMINI_API_KEY);

      const searchResults = await Promise.all(
        understanding.searchQueries.map((q) => tavilySearch(q, env.TAVILY_API_KEY))
      );
      const candidates = dedupeCandidates(searchResults.flat());

      const ranked = await rankCandidates(query, understanding, candidates, env.GEMINI_API_KEY);

      const withHistory = await Promise.all(
        ranked.slice(0, 6).map(async (r) => ({
          ...r,
          wayback: await getWaybackInfo(r.domain).catch(() => null),
        }))
      );

      return json({ results: withHistory, understanding }, 200, corsHeaders);
    } catch (err) {
      return json({ error: "We lost the trail.", detail: String(err) }, 500, corsHeaders);
    }
  },
};

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/* ---------------- STEP 1: Query understanding via Gemini ---------------- */
async function understandQuery(query, apiKey) {
  const prompt = `A user is trying to remember a website/app/tool/game from the internet. Here is their description:

"${query}"

Extract:
1. 2-3 short, concrete web search queries that would help find this thing (as if searching Google)
2. A list of distinct "clues" from their description (visual details, function, approximate date, platform, name fragments)
3. A guessed category: one of website, tool, app, game, article, service, other

Respond ONLY with JSON, no other text, in this exact shape:
{"searchQueries": ["...", "..."], "clues": ["...", "..."], "category": "..."}`;

  const text = await callGemini(prompt, apiKey);
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    return { searchQueries: [query], clues: [query], category: "other" };
  }
}

async function callGemini(prompt, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );
  const data = await res.json();
  return (
    data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || ""
  );
}

/* ---------------- STEP 2: Real web search via Tavily ---------------- */
async function tavilySearch(query, apiKey) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 6,
      include_answer: false,
    }),
  });
  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    domain: safeDomain(r.url),
    snippet: r.content,
  }));
}

function safeDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function dedupeCandidates(list) {
  const seen = new Set();
  return list.filter((item) => {
    if (!item.domain || seen.has(item.domain)) return false;
    seen.add(item.domain);
    return true;
  });
}

/* ---------------- STEP 3: Rank real candidates via Gemini ---------------- */
async function rankCandidates(originalQuery, understanding, candidates, apiKey) {
  if (candidates.length === 0) return [];

  const candidateList = candidates
    .map((c, i) => `${i}. ${c.title} (${c.domain}) — ${c.snippet?.slice(0, 200) || ""}`)
    .join("\n");

  const prompt = `A user is trying to find a website they vaguely remember. Their description:
"${originalQuery}"

Here are real web search results found for this query:
${candidateList}

For each candidate that is PLAUSIBLY relevant, return a match score (0-100, be conservative — never claim certainty), which of the user's clues it matches, and any mismatches. Skip candidates that are clearly irrelevant.

Respond ONLY with JSON in this exact shape:
{"matches": [{"index": 0, "score": 82, "matchedClues": ["..."], "mismatchedClues": ["..."], "reasoning": "one sentence"}]}`;

  const text = await callGemini(prompt, apiKey);
  const clean = text.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    parsed = { matches: [] };
  }

  return parsed.matches
    .filter((m) => candidates[m.index])
    .map((m) => ({
      ...candidates[m.index],
      score: m.score,
      matchedClues: m.matchedClues || [],
      mismatchedClues: m.mismatchedClues || [],
      reasoning: m.reasoning || "",
    }))
    .sort((a, b) => b.score - a.score);
}

/* ---------------- STEP 4: Wayback Machine (free, no key) ---------------- */
async function getWaybackInfo(domain) {
  const res = await fetch(
    `https://archive.org/wayback/available?url=${encodeURIComponent(domain)}`
  );
  const data = await res.json();
  const snap = data.archived_snapshots?.closest;
  if (!snap) return null;
  return {
    available: snap.available,
    url: snap.url,
    timestamp: snap.timestamp, // format: YYYYMMDDhhmmss
  };
}
