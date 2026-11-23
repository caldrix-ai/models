// The e2e's loopback server: the built test pages (dist-test/) at /, nothing else.
//   node tests/e2e/server.mjs --port <n> --dir dist-test
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { URL } from "node:url";

const argv = process.argv.slice(2);
const at = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) throw new Error(`server.mjs: ${flag} takes a value`);
  return argv[i + 1];
};
const port = Number(at("--port"));
const dir = at("--dir");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname));
  if (path.includes("..") || !/^\/[A-Za-z0-9._/-]*$/.test(path)) {
    res.writeHead(400).end();
    return;
  }
  try {
    const body = await readFile(join(dir, path === "/" ? "store.html" : path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1");
