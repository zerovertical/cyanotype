// A tiny static file server for the tests, so nothing beyond Node is needed.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };

export function serve(dir, port) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = normalize(join(dir, path.endsWith("/") ? path + "index.html" : path));
    if (!file.startsWith(normalize(dir))) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

// Uses the Chrome installed on this computer; set CHROME_PATH to use another.
export const chromeOptions = (args = []) => process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH, args }
  : { channel: "chrome", args };
