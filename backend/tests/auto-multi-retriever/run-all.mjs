// Run all functional tests A/B/C/D/F in sequence with a fresh seed
// between each. Captures stdout/stderr per test and prints a final
// pass/fail summary.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runOne = (script) =>
  new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(__dirname, script)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const seed = (args = []) =>
  new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [path.join(__dirname, "seed.mjs"), ...args],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const summarize = (name, out) => {
  const lines = out.split("\n").filter((l) => l.trim());
  // Find PASS / FAIL lines and the canonical "========= TEST X RESULTS =========" block.
  const results = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.includes("TEST " + name.toUpperCase() + " RESULTS")) {
      inBlock = true;
      results.push(line.trim());
      continue;
    }
    if (inBlock) {
      if (line.startsWith("=====")) {
        inBlock = false;
        continue;
      }
      results.push(line.trim());
    }
    if (line.startsWith("PASS:") || line.startsWith("FAIL:")) {
      results.push(line.trim());
    }
  }
  return results;
};

const main = async () => {
  const tests = ["a", "b", "c", "d", "e", "f"];
  const summary = {};

  // Always start with a clean state.
  await seed(["--clean"]);

  for (const t of tests) {
    // Seed for this specific test.
    const seedOut = await seed(["--test=" + t.toUpperCase()]);
    if (seedOut.code !== 0) {
      console.error(`Seed for test ${t.toUpperCase()} failed:`, seedOut.stderr);
      summary[t] = { code: -1, status: "seed-failed" };
      continue;
    }
    const out = await runOne(`test-${t}.mjs`);
    summary[t] = {
      code: out.code,
      status: out.code === 0 ? "PASS" : "FAIL",
      results: summarize(t, out.stdout),
    };
  }

  console.log("\n========== FINAL SUMMARY ==========");
  let allPass = true;
  for (const t of tests) {
    const s = summary[t];
    const mark = s.status === "PASS" ? "✓" : "✗";
    console.log(`  ${mark} Test ${t.toUpperCase()}: ${s.status}`);
    if (s.status !== "PASS") allPass = false;
    for (const line of s.results || []) {
      console.log(`      ${line}`);
    }
  }
  console.log("==================================");
  process.exit(allPass ? 0 : 1);
};

main();
