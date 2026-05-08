const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// --- API keys from environment variables ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FMP_API_KEY = process.env.FMP_API_KEY || "IivcXUTKUaJEGzXdnhQgwyuzSB7HYoHe";

// --- Fetch real stock data from FMP ---
async function getStockData(ticker) {
  if (!FMP_API_KEY) {
    console.log("No FMP key — skipping real data");
    return null;
  }

  try {
    // Profile — gives us price, market cap, sector, beta
    const profileRes = await fetch(
      `https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${FMP_API_KEY}`
    );

    if (!profileRes.ok) {
      console.error("FMP profile failed:", profileRes.status);
      return null;
    }

    const profileData = await profileRes.json();
    console.log("FMP raw profile type:", typeof profileData, Array.isArray(profileData));

    // Handle both array and object responses
    const profile = Array.isArray(profileData) ? profileData[0] : profileData;

    if (!profile || !profile.price) {
      console.error("FMP profile missing price:", JSON.stringify(profile).slice(0, 200));
      return null;
    }

    console.log("FMP got price for", ticker, ":", profile.price);

    // Earnings — gives us upcoming dates
    let earnings = [];
    try {
      const earningsRes = await fetch(
        `https://financialmodelingprep.com/stable/earning_calendar?symbol=${ticker}&apikey=${FMP_API_KEY}`
      );
      if (earningsRes.ok) {
        const earningsData = await earningsRes.json();
        earnings = Array.isArray(earningsData) ? earningsData.slice(0, 2) : [];
        console.log("FMP got", earnings.length, "earnings dates");
      }
    } catch (e) {
      console.log("FMP earnings failed (non-critical):", e.message);
    }

    return {
      companyName: profile.companyName,
      price: profile.price,
      marketCap: profile.marketCap || profile.mktCap,
      sector: profile.sector,
      industry: profile.industry,
      beta: profile.beta,
      range: profile.range,
      volAvg: profile.volAvg || profile.averageVolume,
      lastDividend: profile.lastDividend || profile.lastDiv,
      change: profile.change,
      changePercent: profile.changePercent || profile.changesPercentage,
      earnings: earnings,
    };
  } catch (err) {
    console.error("FMP error:", err.message);
    return null;
  }
}

// --- Scoring prompt ---
function scoringPrompt(ticker, stockData) {
  let dataSection = "";

  if (stockData) {
    dataSection = `
Here is REAL, CURRENT market data for ${ticker}. Use these numbers as your primary source:

Company: ${stockData.companyName}
Current Price: $${stockData.price}
Market Cap: $${(stockData.marketCap / 1e9).toFixed(1)}B
Sector: ${stockData.sector}
Industry: ${stockData.industry}
Beta: ${stockData.beta}
52-Week Range: ${stockData.range}
Avg Volume: ${stockData.volAvg ? stockData.volAvg.toLocaleString() : "N/A"}
Today's Change: ${stockData.changePercent ? stockData.changePercent.toFixed(2) + "%" : "N/A"}
Last Dividend: $${stockData.lastDividend || "N/A"}
${stockData.earnings.length > 0 ? "Next Earnings: " + stockData.earnings[0].date : "Next Earnings: Unknown"}

IMPORTANT: The current price is $${stockData.price}. Use this exact price in your response.
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
- currentPrice: must be exactly ${stockData ? stockData.price : "the current market price"}
- targetPrice: realistic price target as a number
- horizon: one of "1-2 months", "2-3 months", "3-4 months", "4-6 months"
- companyName: full company name
- rationale: one sentence explaining the direction call

CRITICAL: Respond ONLY with valid JSON. No markdown, no backticks, no explanation outside the JSON:
{"fundamental":0,"catalyst":0,"sentiment":0,"risk":0,"insider":0,"direction":"LONG","currentPrice":0.00,"targetPrice":0.00,"horizon":"1-2 months","companyName":"Company Name","rationale":"one sentence"}`;
}

// --- Rules-based Financial Health scoring ---
function calcFinancialHealth(stockData) {
  let score = 0;

  // Market Cap (40 points max)
  const cap = stockData.marketCap;
  if (cap > 200e9) score += 40;        // Mega cap
  else if (cap > 10e9) score += 30;    // Large cap
  else if (cap > 2e9) score += 20;     // Mid cap
  else if (cap > 300e6) score += 12;   // Small cap
  else score += 5;                      // Micro cap

  // Beta - volatility (30 points max)
  const beta = stockData.beta;
  if (beta !== null && beta !== undefined) {
    if (beta < 0.8) score += 30;
    else if (beta <= 1.2) score += 25;
    else if (beta <= 1.8) score += 15;
    else score += 8;
  } else {
    score += 15; // Unknown beta, neutral
  }

  // 52-week range position (30 points max)
  const range = stockData.range;
  if (range) {
    const parts = range.split("-").map(s => parseFloat(s.trim()));
    if (parts.length === 2 && parts[1] > parts[0]) {
      const low = parts[0];
      const high = parts[1];
      const position = (stockData.price - low) / (high - low);

      if (position >= 0.4 && position <= 0.7) score += 30;       // Healthy middle
      else if (position > 0.7 && position <= 0.85) score += 25;  // Upper range
      else if (position >= 0.25 && position < 0.4) score += 20;  // Lower-middle
      else if (position > 0.85) score += 15;                      // Near highs
      else score += 10;                                            // Near lows
    } else {
      score += 15; // Can't parse range, neutral
    }
  } else {
    score += 15; // No range data, neutral
  }

  return Math.min(100, Math.max(0, score));
}

// --- API endpoint ---
app.post("/api/analyze", async (req, res) => {
  const { ticker } = req.body;

  if (!ticker || typeof ticker !== "string" || ticker.length > 6) {
    return res.status(400).json({ error: "Invalid ticker" });
  }

  const t = ticker.trim().toUpperCase();
  console.log("--- Analyzing:", t, "---");

  try {
    // Step 1: Get real stock data from FMP
    const stockData = await getStockData(t);
    console.log("FMP result:", stockData ? "Got data, price=" + stockData.price : "No data");

    // Step 2: Send to Gemini for scoring
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: scoringPrompt(t, stockData) }] }],
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
      console.error("Could not parse Gemini response:", cleaned.slice(0, 300));
      return res.status(500).json({ error: "Could not parse AI response" });
    }

    const scores = JSON.parse(jsonMatch[0]);

    // ALWAYS use FMP price if available — override whatever Gemini says
    const currentPrice = stockData?.price || scores.currentPrice;
    console.log("Final price:", currentPrice, "(FMP:", stockData?.price, "Gemini:", scores.currentPrice, ")");

    // --- Rules-based Financial Health score ---
    // Override Gemini's fundamental score with data-driven score when FMP data available
    if (stockData) {
      const fundamentalScore = calcFinancialHealth(stockData);
      console.log("Rules-based Financial Health:", fundamentalScore, "(Gemini was:", scores.fundamental, ")");
      scores.fundamental = fundamentalScore;
    }

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
    const result = {
      ticker: t,
      companyName: scores.companyName || stockData?.companyName || t,
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
    };

    console.log("--- Result for", t, ": price=$" + currentPrice, "direction=" + scores.direction, "---");
    res.json(result);

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
