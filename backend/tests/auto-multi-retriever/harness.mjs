// Test harness utilities — shared by all functional tests.
//
// The orchestrator calls Python ML at `${ML_BASE_URL}/recommend`.
// To isolate the test from a live ML service, this harness starts a
// tiny in-process HTTP server that returns a canned persona result.
// We rewrite `ML_BASE_URL` to point at it before importing the
// orchestrator (config import is cached, but the orchestrator reads
// `ML_BASE_URL` at call time, so we set the env var before import).
//
// If `ML_BASE_URL` is already set in the environment and not
// overridden here, the orchestrator will hit whatever's there. Tests
// always override.

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

// Start a localhost mock Python /recommend server on a free port.
// Returns { url, close }.
export function startMockPersonaServer(cannedResults) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/recommend") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ results: cannedResults }));
        } else {
          res.writeHead(404);
          res.end("not found");
        }
      });
    });
    // Track open sockets so close() can force-destroy idle ones. This
    // avoids the libuv "handle->flags & UV_HANDLE_CLOSING" assertion
    // that fires when sockets are still open at process exit on Windows.
    const openSockets = new Set();
    server.on("connection", (socket) => {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () =>
          new Promise((r) => {
            for (const s of openSockets) {
              try { s.destroy(); } catch (_) {}
            }
            server.close(() => r());
          }),
      });
    });
    server.on("error", reject);
  });
}

// Run a child Node process with the given env. Returns a promise that
// resolves with { code, stdout, stderr }.
export function runChildNode(scriptPath, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Lightweight assertion helpers — throw on failure with a clear msg.
export function assert(cond, msg) {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `assertEqual failed (${msg || ""}): expected ${JSON.stringify(
        expected,
      )}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      `assertDeepEqual failed (${msg || ""}):\n  expected: ${e}\n  got:      ${a}`,
    );
  }
}
