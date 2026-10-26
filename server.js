// Lights Out server for Render (or any Node host)
//
// Serves the website (index.html) and runs the AI coach backend from
// worker.js
//
// Render settings:
//   Language: Node
//   Build command: npm install
//   Start command: npm start
//   Environment variables:
//     ANTHROPIC_API_KEY  your Claude API key (keep it secret)
//     ALLOWED_ORIGIN     your Render address, e.g. https://lights-out.onrender.com
//     MODEL              (optional) defaults to claude-haiku-5-5

import http from "node:http";
import { readFile } from "node:fs/promises";
import worker from "./worker.js";

const PORT = process.env.PORT || 3000;
const MAX_BODY = 6_000_000; // big enough for a schedule screenshot

const server = http.createServer(async (req, res) => {
  try {
    // The website
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = await readFile(new URL("./index.html", import.meta.url));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "GET") {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }

    // The AI coach: hand the request to worker.js
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) { res.writeHead(413); return res.end("Too large"); }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    // Render puts the visitor's IP here; the worker's rate limit uses it.
    const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
    if (ip) headers.set("CF-Connecting-IP", ip);

    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Something went wrong on the server." }));
  }
});

server.listen(PORT, () => console.log(`Lights Out running on port ${PORT}`));
