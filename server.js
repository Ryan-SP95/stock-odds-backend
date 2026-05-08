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

// --- Rules-based Risk Assessment scoring ---
// Higher score = LOWER risk
// 100 points max: Beta(25) + Earnings(25) + 52w Extension(20) + MarketCap(15) + Daily Move(15)
function calcRiskAssessment(stockData) {
  let score = 0;
  let factors = [];

  // 1. Beta - 25 points max
  const beta = stockData.beta;
  if (beta !== null && beta !== undefined) {
    if (beta < 0.6)        { score += 25; factors.push("beta<0.6: +25"); }
    else if (beta < 0.8)   { score += 22; factors.push("beta<0.8: +22"); }
    else if (beta <= 1.0)  { score += 20; factors.push("beta<=1.0: +20"); }
    else if (beta <= 1.2)  { score += 16; factors.push("beta<=1.2: +16"); }
    else if (beta <= 1.5)  { score += 12; factors.push("beta<=1.5: +12"); }
    else if (beta <= 1.8)  { score += 8;  factors.push("beta<=1.8: +8"); }
    else if (beta <= 2.2)  { score += 4;  factors.push("beta<=2.2: +4"); }
    else                    { score += 2;  factors.push("beta>2.2: +2"); }
  } else {
    score += 12;
    factors.push("beta unknown: +12");
  }

  // 2. Earnings Proximity - 25 points max
  let earningsHandled = false;
  if (stockData.earnings && stockData.earnings.length > 0 && stockData.earnings[0].date) {
    const earningsDate = new Date(stockData.earnings[0].date);
    const now = new Date();
    const daysUntil = Math.round((earningsDate - now) / (1000 * 60 * 60 * 24));

    if (daysUntil >= 0) {
      if (daysUntil > 60)      { score += 25; factors.push("earnings " + daysUntil + "d: +25"); }
      else if (daysUntil > 30) { score += 22; factors.push("earnings " + daysUntil + "d: +22"); }
      else if (daysUntil > 14) { score += 16; factors.push("earnings " + daysUntil + "d: +16"); }
      else if (daysUntil > 7)  { score += 10; factors.push("earnings " + daysUntil + "d: +10"); }
      else if (daysUntil > 3)  { score += 5;  factors.push("earnings " + daysUntil + "d: +5"); }
      else                      { score += 2;  factors.push("earnings " + daysUntil + "d (imminent): +2"); }
      earningsHandled = true;
    } else if (daysUntil >= -3) {
      score += 8;
      factors.push("earnings " + Math.abs(daysUntil) + "d ago: +8");
      earningsHandled = true;
    }
  }
  if (!earningsHandled) {
    score += 14;
    factors.push("earnings unknown: +14");
  }

  // 3. 52-Week Overextension - 20 points max
  const range = stockData.range;
  if (range) {
    const parts = range.split("-").map(s => parseFloat(s.trim()));
    if (parts.length === 2 && parts[1] > parts[0]) {
      const low = parts[0];
      const high = parts[1];
      const position = (stockData.price - low) / (high - low);

      if (position >= 0.3 && position <= 0.7)       { score += 20; factors.push("52w " + (position * 100).toFixed(0) + "% mid: +20"); }
      else if (position > 0.7 && position <= 0.85)  { score += 14; factors.push("52w " + (position * 100).toFixed(0) + "% upper: +14"); }
      else if (position >= 0.15 && position < 0.3)  { score += 12; factors.push("52w " + (position * 100).toFixed(0) + "% lower: +12"); }
      else if (position > 0.85)                      { score += 8;  factors.push("52w " + (position * 100).toFixed(0) + "% near-high: +8"); }
      else                                            { score += 6;  factors.push("52w " + (position * 100).toFixed(0) + "% near-low: +6"); }
    } else {
      score += 10; factors.push("52w unparseable: +10");
    }
  } else {
    score += 10; factors.push("52w missing: +10");
  }

  // 4. Market Cap - 15 points max
  const cap = stockData.marketCap;
  if (cap) {
    if (cap > 200e9)      { score += 15; factors.push("megacap: +15"); }
    else if (cap > 50e9)  { score += 13; factors.push("large>50B: +13"); }
    else if (cap > 10e9)  { score += 11; factors.push("large>10B: +11"); }
    else if (cap > 2e9)   { score += 8;  factors.push("midcap: +8"); }
    else if (cap > 300e6) { score += 5;  factors.push("smallcap: +5"); }
    else                   { score += 2;  factors.push("microcap: +2"); }
  } else {
    score += 7; factors.push("cap unknown: +7");
  }

  // 5. Recent Daily Move - 15 points max
  const changePercent = stockData.changePercent;
  if (changePercent !== null && changePercent !== undefined) {
    const absChange = Math.abs(changePercent);
    if (absChange < 1)      { score += 15; factors.push("daily " + absChange.toFixed(1) + "% calm: +15"); }
    else if (absChange < 2) { score += 12; factors.push("daily " + absChange.toFixed(1) + "% normal: +12"); }
    else if (absChange < 3) { score += 9;  factors.push("daily " + absChange.toFixed(1) + "% elevated: +9"); }
    else if (absChange < 5) { score += 5;  factors.push("daily " + absChange.toFixed(1) + "% high: +5"); }
    else if (absChange < 8) { score += 3;  factors.push("daily " + absChange.toFixed(1) + "% v.high: +3"); }
    else                     { score += 1;  factors.push("daily " + absChange.toFixed(1) + "% extreme: +1"); }
  } else {
    score += 8; factors.push("daily unknown: +8");
  }

  const finalScore = Math.min(100, Math.max(0, score));
  console.log("Risk Assessment breakdown:", factors.join(" | "), "=", finalScore);
  return finalScore;
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
    
    // --- Rules-based score overrides when FMP data available ---
    if (stockData) {
      const fundamentalScore = calcFinancialHealth(stockData);
      console.log("Rules-based Financial Health:", fundamentalScore, "(Gemini was:", scores.fundamental, ")");
      scores.fundamental = fundamentalScore;

      // Risk Assessment (rules-based)
      const riskScore = calcRiskAssessment(stockData);
      console.log("Rules-based Risk Assessment:", riskScore, "(Gemini was:", scores.risk, ")");
      scores.risk = riskScore;
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
  res.json({ status: "Stock Odds API is running", version: "1.1.0" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Stock Odds API v1.1.0 running on port ${PORT}`);
  console.log("Rules-based scoring: Financial Health + Risk Assessment");
});
