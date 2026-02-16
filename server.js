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

// Cache to respect rate limits (8 req/min free tier)
const cache = {};
const CACHE_TTL = {
  price: 8000,      // 8s
  quote: 30000,     // 30s
  candles: 60000,   // 60s
};

async function cachedFetch(key, url, ttl) {
  const now = Date.now();
  if (cache[key] && now - cache[key].ts < ttl) return cache[key].data;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "error") {
      cache[key] = { data, ts: now };
    }
    return data;
  } catch (err) {
    console.error(`Fetch error [${key}]:`, err.message);
    return cache[key]?.data || { error: err.message };
  }
}

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// API: Real-time price
app.get("/api/price", async (req, res) => {
  const data = await cachedFetch(
    "price",
    `https://api.twelvedata.com/price?symbol=AUD/CHF&apikey=${API_KEY}`,
    CACHE_TTL.price
  );
  res.json(data);
});

// API: Quote (high, low, open, close, volume)
app.get("/api/quote", async (req, res) => {
  const data = await cachedFetch(
    "quote",
    `https://api.twelvedata.com/quote?symbol=AUD/CHF&apikey=${API_KEY}`,
    CACHE_TTL.quote
  );
  res.json(data);
});

// API: Candles
app.get("/api/candles", async (req, res) => {
  const tf = req.query.interval || "5min";
  const size = req.query.size || "100";
  const key = `candles_${tf}_${size}`;
  const data = await cachedFetch(
    key,
    `https://api.twelvedata.com/time_series?symbol=AUD/CHF&interval=${tf}&outputsize=${size}&apikey=${API_KEY}`,
    CACHE_TTL.candles
  );
  res.json(data);
});

// Health check for Render
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`AUD/CHF Predictor running on port ${PORT}`);
});
