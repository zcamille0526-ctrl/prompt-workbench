import express from "express";
import { handler as verifyHandler } from "./api/verify.js";
import { handler as promptsHandler } from "./api/prompts.js";

const app = express();
const PORT = 3001;

app.use(express.json());

app.post("/api/verify", async (req, res) => {
  const request = new Request(`http://localhost:${PORT}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req.body),
  });
  const response = await verifyHandler(request);
  const data = await response.json();
  res.status(response.status).json(data);
});

app.all("/api/prompts", async (req, res) => {
  const url = new URL(`http://localhost:${PORT}${req.originalUrl}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (req.headers.authorization) {
    headers.authorization = req.headers.authorization as string;
  }

  const init: RequestInit = {
    method: req.method,
    headers,
  };
  if (["POST", "PUT"].includes(req.method)) {
    init.body = JSON.stringify(req.body);
  }

  const request = new Request(url.toString(), init);
  const response = await promptsHandler(request);
  const data = await response.json();
  res.status(response.status).json(data);
});

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
