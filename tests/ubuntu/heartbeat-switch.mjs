/**
 * A stand-in dead man's switch for tests/ubuntu/heartbeat.sh: it answers 200 to anything and writes
 * one line per request (method, path, the headers' names, the body's length) to the file named, so
 * the test can prove what a heartbeat carries and how many arrived.
 *
 *   node tests/ubuntu/heartbeat-switch.mjs <port> <log file>
 */
import { appendFileSync } from "node:fs";
import http from "node:http";

const [port, log] = [Number(process.argv[2]), process.argv[3]];
http.createServer((request, response) => {
  let length = 0;
  request.on("data", (chunk) => { length += chunk.length; });
  request.on("end", () => {
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), method: request.method, path: request.url, headers: Object.keys(request.headers).sort(), userAgent: request.headers["user-agent"] ?? null, bodyBytes: length })}\n`);
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("OK");
  });
}).listen(port, "127.0.0.1");
