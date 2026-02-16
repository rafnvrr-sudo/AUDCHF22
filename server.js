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

// ===== RATE LIMITER =====
// Twelve Data free: 8 credits/min, 800/day
// Strategy: alternate price(P) and candles(C) every ~8s
// Pattern per minute: P C P C P C P = 7 calls/min, 1 margin
// Analysis runs on every candle update = every ~16s

const state = {
  price: null,
  quote: null,
  candles: {},
  lastPrice: 0,
  lastQuote: 0,
  lastCandles: {},
  lastUpdate: 0,
  apiCalls: []
};

function canCallAPI() {
  const now = Date.now();
  state.apiCalls = state.apiCalls.filter(t => now - t < 60000);
  return state.apiCalls.length < 7;
}

function trackCall() {
  state.apiCalls.push(Date.now());
}

async function safeFetch(url, label) {
  if (!canCallAPI()) {
    console.log(`[RATE] Skip ${label} (${state.apiCalls.length}/8 this min)`);
    return null;
  }
  try {
    trackCall();
    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();
    if (data.status === "error") {
      console.error(`[API] ${label}: ${data.message}`);
      return null;
    }
    return data;
  } catch (err) {
    console.error(`[ERR] ${label}: ${err.message}`);
    return null;
  }
}

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
    state.lastUpdate = Date.now();
    broadcast({ type: "price", data, ts: state.lastPrice });
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
    state.lastUpdate = Date.now();
    // Extract quote from latest candle
    const latest = data.values[0];
    if (latest) {
      const dayCandles = data.values.slice(0, 60);
      state.quote = {
        high: Math.max(...dayCandles.map(v => +v.high)),
        low: Math.min(...dayCandles.map(v => +v.low)),
        open: +dayCandles[dayCandles.length - 1].open
      };
      state.lastQuote = Date.now();
      broadcast({ type: "quote", data: state.quote, ts: state.lastQuote });
    }
    broadcast({ type: "candles", interval, data, ts: state.lastCandles[interval] });
  }
}

function broadcast(msg) {
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

// Alternating poll: P, C, P, C, P, C, P = 7 calls/min
let tick = 0;
let pollTimer;

function startPolling() {
  // Initial burst
  pollPrice();
  setTimeout(() => pollCandles(activeTimeframe), 3000);

  // Alternate every 8s
  pollTimer = setInterval(() => {
    tick++;
    if (tick % 2 === 0) {
      pollCandles(activeTimeframe);
    } else {
      pollPrice();
    }
  }, 8500);

  console.log("[POLL] Started: price/candles alternating every 8.5s = ~7 calls/min");
}

// ===== SSE =====
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  sseClients.add(res);

  if (state.price) res.write(`data: ${JSON.stringify({ type: "price", data: state.price, ts: state.lastPrice })}\n\n`);
  if (state.quote) res.write(`data: ${JSON.stringify({ type: "quote", data: state.quote, ts: state.lastQuote })}\n\n`);
  if (state.candles[activeTimeframe]) res.write(`data: ${JSON.stringify({ type: "candles", interval: activeTimeframe, data: state.candles[activeTimeframe], ts: state.lastCandles[activeTimeframe] })}\n\n`);

  const hb = setInterval(() => {
    try { res.write(": hb\n\n"); } catch (e) { clearInterval(hb); }
  }, 25000);

  req.on("close", () => { sseClients.delete(res); clearInterval(hb); });
});

// ===== REST =====
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/price", (req, res) => res.json(state.price || { error: "Loading" }));
app.get("/api/quote", (req, res) => res.json(state.quote || { error: "Loading" }));

app.get("/api/candles", (req, res) => {
  const tf = req.query.interval || "1min";
  if (tf !== activeTimeframe) {
    activeTimeframe = tf;
    if (!state.candles[tf] || Date.now() - (state.lastCandles[tf] || 0) > 15000) {
      pollCandles(tf);
    }
  }
  res.json(state.candles[tf] || { error: "Loading..." });
});

app.get("/api/status", (req, res) => {
  const now = Date.now();
  res.json({
    calls: state.apiCalls.filter(t => now - t < 60000).length,
    max: 8,
    clients: sseClients.size,
    tf: activeTimeframe,
    lastUpdate: state.lastUpdate ? new Date(state.lastUpdate).toISOString() : null
  });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`AUD/CHF Predictor on port ${PORT}`);
  startPolling();
});
