import express from "express";

const app = express();
app.use(express.json());

// Mutable test fixture
let fixture = {
  results: [
    {
      title: "OpenClaw GitHub",
      url: "https://github.com/openclaw/openclaw",
      description: "OpenClaw is an open-source AI agent runtime.",
    },
  ],
};
const requestLog = [];

// ---- Brave-API surface (/res/v1/web/search) ----
app.get("/res/v1/web/search", (req, res) => {
  const apiKey = req.headers["x-subscription-token"];
  requestLog.push({ query: req.query.q, apiKey });
  if (apiKey === "invalid") return res.status(401).json({ error: "Unauthorized" });
  res.json({
    web: {
      results: fixture.results.map((r) => ({
        title: r.title,
        url: r.url,
        description: r.description,
      })),
    },
  });
});

// ---- Control plane ----
app.get("/control/health", (_req, res) => res.json({ ok: true }));
app.post("/control/reset", (_req, res) => {
  fixture = {
    results: [
      {
        title: "OpenClaw GitHub",
        url: "https://github.com/openclaw/openclaw",
        description: "OpenClaw is an open-source AI agent runtime.",
      },
    ],
  };
  requestLog.length = 0;
  res.json({ ok: true });
});
app.post("/control/seed", (req, res) => {
  if (Array.isArray(req.body?.results)) fixture.results = req.body.results;
  res.json({ ok: true });
});
app.get("/control/requests", (_req, res) => res.json(requestLog));

const port = Number(process.env.PORT ?? 9003);
app.listen(port, () => console.log(`brave-mock listening on ${port}`));
