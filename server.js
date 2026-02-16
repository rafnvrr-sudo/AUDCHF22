const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_KEY;
if (!API_KEY) {
  console.error("TWELVE_DATA_KEY env variable is required");
  process.exit(1);
}

// ===== SMART RATE LIMITER =====
// Twelve Data free tier: 8 API credits/minute, 800/day
// Strategy: server polls on a fixed schedule, clients receive cached data instantly
// Budget per minute: 3 calls for price, 1 for quote, 1 for candles = 5/min max

const state = {
  price: null,
  quote: null,
  candles: {},       // keyed by interval
  lastPrice: 0,
  lastQuote: 0,
  lastCandles: {},   // keyed by interval
  apiCalls: [],      // timestamps of API calls for rate tracking
  errors: []
};

function canCallAPI() {
  const now = Date.now();
  // Remove calls older than 60s
  state.apiCalls = state.apiCalls.filter(t => now - t < 60000);
  // Keep 1 credit margin for safety
  return state.apiCalls.length < 7;
}

function trackCall() {
  state.apiCalls.push(Date.now());
}

async function safeFetch(url, label) {
  if (!canCallAPI()) {
    console.log(`[RATE] Skipping ${label} (${state.apiCalls.length}/8 used this minute)`);
    return null;
  }
  try {
    trackCall();
    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();
    if (data.status === "error") {
      console.error(`[API ERROR] ${label}: ${data.message}`);
      if (data.message && data.message.includes("credits")) {
        // Rate limited by API, pause for remaining minute
        console.log("[RATE] API rate limit hit, backing off");
      }
      return null;
    }
    return data;
  } catch (err) {
    console.error(`[FETCH ERROR] ${label}: ${err.message}`);
    return null;
  }
}

// ===== SERVER-SIDE POLLING =====
// Price: every 20s (3 calls/min)
// Quote: every 60s (1 call/min)  
// Candles: every 90s for active timeframe (< 1 call/min)
// Total: ~5 calls/min, well under 8 limit

let activeTimeframe = "1min";
const sseClients = new Set();

async function pollPrice() {
  const data = await safeFetch(
    `https://api.twelvedata.com/price?symbol=AUD/CHF&apikey=${API_KEY}`,
    "price"
  );
  if (data && data.price) {
    state.price = data;
    state.lastPrice = Date.now();
    broadcast({ type: "price", data, ts: state.lastPrice });
  }
}

async function pollQuote() {
  const data = await safeFetch(
    `https://api.twelvedata.com/quote?symbol=AUD/CHF&apikey=${API_KEY}`,
    "quote"
  );
  if (data && data.high) {
    state.quote = data;
    state.lastQuote = Date.now();
    broadcast({ type: "quote", data, ts: state.lastQuote });
  }
}

async function pollCandles(interval) {
  const data = await safeFetch(
    `https://api.twelvedata.com/time_series?symbol=AUD/CHF&interval=${interval}&outputsize=100&apikey=${API_KEY}`,
    `candles_${interval}`
  );
  if (data && data.values) {
    state.candles[interval] = data;
    state.lastCandles[interval] = Date.now();
    broadcast({ type: "candles", interval, data, ts: state.lastCandles[interval] });
  }
}

function broadcast(msg) {
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

// Start polling loops
let priceTimer, quoteTimer, candleTimer;

function startPolling() {
  // Initial fetch
  pollPrice();
  setTimeout(() => pollQuote(), 2000);
  setTimeout(() => pollCandles(activeTimeframe), 4000);

  // Price every 20s
  priceTimer = setInterval(pollPrice, 20000);
  // Quote every 60s
  quoteTimer = setInterval(pollQuote, 60000);
  // Candles every 90s
  candleTimer = setInterval(() => pollCandles(activeTimeframe), 90000);

  console.log("[POLL] Server-side polling started (price:20s, quote:60s, candles:90s)");
}

// ===== SSE ENDPOINT =====
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });

  sseClients.add(res);
  console.log(`[SSE] Client connected (${sseClients.size} total)`);

  // Send current state immediately
  if (state.price) {
    res.write(`data: ${JSON.stringify({ type: "price", data: state.price, ts: state.lastPrice })}\n\n`);
  }
  if (state.quote) {
    res.write(`data: ${JSON.stringify({ type: "quote", data: state.quote, ts: state.lastQuote })}\n\n`);
  }
  if (state.candles[activeTimeframe]) {
    res.write(`data: ${JSON.stringify({ type: "candles", interval: activeTimeframe, data: state.candles[activeTimeframe], ts: state.lastCandles[activeTimeframe] })}\n\n`);
  }

  // Heartbeat every 30s to keep connection alive
  const hb = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch (e) { clearInterval(hb); }
  }, 30000);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(hb);
    console.log(`[SSE] Client disconnected (${sseClients.size} remaining)`);
  });
});

// ===== REST ENDPOINTS (fallback + timeframe switch) =====
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/price", (req, res) => {
  res.json(state.price || { error: "No data yet" });
});

app.get("/api/quote", (req, res) => {
  res.json(state.quote || { error: "No data yet" });
});

app.get("/api/candles", (req, res) => {
  const tf = req.query.interval || "1min";
  // If new timeframe requested, switch active and fetch
  if (tf !== activeTimeframe) {
    activeTimeframe = tf;
    if (!state.candles[tf] || Date.now() - (state.lastCandles[tf] || 0) > 30000) {
      pollCandles(tf);
    }
  }
  res.json(state.candles[tf] || { error: "Loading..." });
});

app.get("/api/status", (req, res) => {
  const now = Date.now();
  const callsThisMinute = state.apiCalls.filter(t => now - t < 60000).length;
  res.json({
    status: "ok",
    apiCallsThisMinute: callsThisMinute,
    maxPerMinute: 8,
    clients: sseClients.size,
    activeTimeframe,
    hasPrice: !!state.price,
    hasQuote: !!state.quote,
    hasCandles: !!state.candles[activeTimeframe],
    lastPrice: state.lastPrice ? new Date(state.lastPrice).toISOString() : null,
    lastQuote: state.lastQuote ? new Date(state.lastQuote).toISOString() : null
  });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`AUD/CHF Predictor running on port ${PORT}`);
  startPolling();
});
