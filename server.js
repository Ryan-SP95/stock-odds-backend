const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// --- API keys from environment variables ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FMP_API_KEY = process.env.FMP_API_KEY;

// --- Fetch FMP data ---
async function fetchFMP(endpoint) {
  const url = `https://financialmodelingprep.com/stable/${endpoint}&apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function getFinancialData(ticker) {
  try {
    const [profile, ratios, prices, earnings] = await Promise.all([
      fetchFMP(`profile?symbol=${ticker}`),
      fetchFMP(`ratios?symbol=${ticker}&limit=1`),
      fetchFMP(`historical-price-full?symbol=${ticker}&timeseries=30`),
      fetchFMP(`earning_calendar?symbol=${ticker}`),
    ]);

    const p = profile?.[0] || {};
    const r = ratios?.[0] || {};
    const priceHistory = prices?.historical?.slice(0, 10) || [];
    const earningsData = earnings?.slice(0, 2) || [];

    return {
      profile: {
        companyName: p.companyName || ticker,
        sector: p.sector || "Unknown",
        industry: p.industry || "Unknown",
        marketCap: p.mktCap,
        price: p.price,
        beta: p.beta,
        volAvg: p.volAvg,
      },
      ratios: {
        peRatio: r.priceEarningsRatio,
        debtToEquity: r.debtEquityRatio,
        currentRatio: r.currentRatio,
        returnOnEquity: r.returnOnEquity,
        grossProfitMargin: r.grossProfitMargin,
        netProfitMargin: r.netProfitMargin,
      },
      recentPrices: priceHistory.map((d) => ({
        date: d.date,
        close: d.close,
        changePercent: d.changePercent,
      })),
      earnings: earningsData,
    };
  } catch (err) {
    console.error("FMP fetch error:", err.message);
    return null;
  }
}

// --- Scoring prompt ---
function scoringPrompt(ticker, fmpData) {
  let dataSection = "";

  if (fmpData) {
    dataSection = `
Here is real, current financial data for ${ticker}:

COMPANY PROFILE:
${JSON.stringify(fmpData.profile, null, 2)}

KEY FINANCIAL RATIOS:
${JSON.stringify(fmpData.ratios, null, 2)}

RECENT PRICE DATA (last 10 trading days):
${JSON.stringify(fmpData.recentPrices, null, 2)}

UPCOMING EARNINGS:
${JSON.stringify(fmpData.earnings, null, 2)}

Use this data as the primary basis for your scoring. The current stock price is $${fmpData.profile.price}.
`;
  } else {
    dataSection = `Research the stock ticker "${ticker}" using your knowledge of current market data.`;
  }

  return `You are a stock analysis engine for an entertainment app. ${dataSection}

Score these categories 1-100:

1. FUNDAMENTAL STRENGTH (25%): Based on revenue growth, margins, valuation ratios, balance sheet
2. CATALYST CLARITY (20%): Upcoming earnings, product launches, regulatory events, macro catalysts
3. SENTIMENT & MOMENTUM (15%): Recent price action, analyst consensus, institutional positioning
4. RISK ASSESSMENT (25%): Debt, volatility, litigation, binary events nearby — higher score = lower risk
5. INSIDER ACTIVITY (15%): Recent insider buying/selling patterns — score 50 if insufficient data

Also provide:
- direction: "LONG" or "SHORT"
- currentPrice: current stock price as a number (use the real price from the data above if available)
- targetPrice: realistic price target as a number
- horizon: one of "1-2 months", "2-3 months", "3-4 months", "4-6 months"
- companyName: full company name
- rationale: one sentence explaining the direction call

CRITICAL: Respond ONLY with valid JSON. No markdown, no backticks, no explanation outside the JSON:
{"fundamental":0,"catalyst":0,"sentiment":0,"risk":0,"insider":0,"direction":"LONG","currentPrice":0.00,"targetPrice":0.00,"horizon":"1-2 months","companyName":"Company Name","rationale":"one sentence"}`;
}

// --- API endpoint ---
app.post("/api/analyze", async (req, res) => {
  const { ticker } = req.body;

  if (!ticker || typeof ticker !== "string" || ticker.length > 6) {
    return res.status(400).json({ error: "Invalid ticker" });
  }

  const t = ticker.trim().toUpperCase();

  try {
    // Step 1: Pull real financial data from FMP (if key available)
    let fmpData = null;
    if (FMP_API_KEY) {
      fmpData = await getFinancialData(t);
    }

    // Step 2: Send data to Gemini for scoring
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: scoringPrompt(t, fmpData) }] }],
          generationConfig: { temperature: 0 },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data);
      return res.status(500).json({ error: "AI scoring failed" });
    }

    // Extract text from Gemini response
    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("") || "";

    if (!text) {
      return res.status(500).json({ error: "No response from AI" });
    }

    // Parse JSON from response
    const cleaned = text.replace(/```json|```/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "Could not parse AI response" });
    }

    const scores = JSON.parse(jsonMatch[0]);

    // Use FMP price if available (more accurate than Gemini's guess)
    const currentPrice =
      fmpData?.profile?.price || scores.currentPrice;

    // Compute overall score
    const overall = Math.round(
      scores.fundamental * 0.25 +
        scores.catalyst * 0.2 +
        scores.sentiment * 0.15 +
        scores.risk * 0.25 +
        scores.insider * 0.15
    );

    const probability = Math.min(
      92,
      Math.max(51, overall + Math.round((Math.random() - 0.5) * 6))
    );

    // Return result
    res.json({
      ticker: t,
      companyName: scores.companyName || fmpData?.profile?.companyName || t,
      direction: scores.direction,
      currentPrice: currentPrice,
      targetPrice: scores.targetPrice,
      horizon: scores.horizon,
      probability,
      overall,
      rationale: scores.rationale || "",
      scores: {
        fundamental: scores.fundamental,
        catalyst: scores.catalyst,
        sentiment: scores.sentiment,
        risk: scores.risk,
        insider: scores.insider,
      },
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// --- Health check ---
app.get("/", (req, res) => {
  res.json({ status: "Stock Odds API is running" });
});

// --- Start server ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Stock Odds API running on port ${PORT}`);
});
