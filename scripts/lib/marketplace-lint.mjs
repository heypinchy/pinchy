/**
 * Syntax + structural guards for the marketplace deploy artifacts. These can't
 * be test-deployed in CI (they need a DigitalOcean account / CapRover server),
 * so this catches the cheap-but-costly regressions before a founder wastes a
 * build: a broken shell script, malformed template JSON, or a critical CapRover
 * field (e.g. PINCHY_INTERNAL_URL) silently dropped.
 *
 * No YAML parser is available to the script runner, so the CapRover checks are
 * targeted text invariants — which is actually stronger than a generic parse
 * for catching meaningful breakage (a removed env line still parses as YAML).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Recursively collects files under `dir` whose first line is a /bin/sh or
 * /bin/bash shebang — catches both `.sh` scripts and extension-less ones
 * (cloud-init's 001_onboot, the MOTD 99-one-click).
 * @param {string} dir
 * @returns {string[]} absolute-ish file paths
 */
export function findShellScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...findShellScripts(full));
      continue;
    }
    let firstLine = "";
    try {
      firstLine = readFileSync(full, "utf8").split("\n", 1)[0];
    } catch {
      continue;
    }
    if (/^#!\s*\/\S*\/(ba)?sh\b/.test(firstLine)) out.push(full);
  }
  return out;
}

/**
 * Runs `bash -n` (parse-only, no execution) on a shell file.
 * @param {string} file
 * @throws {Error} with the file and stderr on a syntax error
 */
export function checkShellSyntax(file) {
  try {
    execFileSync("bash", ["-n", file], { stdio: "pipe" });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString() : err.message;
    throw new Error(`Shell syntax error in ${file}:\n${detail}`);
  }
}

/**
 * Validates the DigitalOcean Packer template's JSON and critical structure.
 * @param {string} content - raw template.json contents
 * @throws {Error} on invalid JSON or a missing required field
 */
export function assertValidPackerTemplate(content) {
  let template;
  try {
    template = JSON.parse(content);
  } catch (e) {
    throw new Error(`template.json is not valid JSON: ${e.message}`);
  }
  if (
    !/^v\d+\.\d+\.\d+$/.test(template?.variables?.application_version ?? "")
  ) {
    throw new Error(
      "template.json variables.application_version must be a vX.Y.Z string",
    );
  }
  if (
    !Array.isArray(template.builders) ||
    !template.builders.some((b) => b.type === "digitalocean")
  ) {
    throw new Error("template.json must declare a digitalocean builder");
  }
  if (
    !Array.isArray(template.provisioners) ||
    template.provisioners.length === 0
  ) {
    throw new Error("template.json must declare provisioners");
  }
}

/**
 * Validates the CapRover one-click template's critical invariants. Text-based
 * (no YAML lib); each invariant is a regression we have already hit or that
 * would silently break a real deploy.
 * @param {string} content - raw pinchy.yml contents
 * @throws {Error} on a missing invariant
 */
export function assertValidCaproverTemplate(content) {
  const required = [
    ["captainVersion: 4", "captainVersion: 4 header"],
    ["$$cap_appname-db", "db service"],
    ["$$cap_appname-pinchy", "pinchy service"],
    ["$$cap_appname-openclaw", "openclaw service"],
    [
      "PINCHY_INTERNAL_URL",
      "PINCHY_INTERNAL_URL (OpenClaw plugins can't reach Pinchy on CapRover's remapped DNS without it)",
    ],
    ["srv-captain--$$cap_appname-pinchy", "srv-captain-- inter-service DNS"],
    ["caproverOneClickApp", "caproverOneClickApp metadata block"],
  ];
  for (const [needle, label] of required) {
    if (!content.includes(needle)) {
      throw new Error(`CapRover template is missing ${label} ("${needle}")`);
    }
  }
  if (!/defaultValue:\s*['"]?v\d+\.\d+\.\d+/.test(content)) {
    throw new Error("CapRover template must pin a vX.Y.Z version defaultValue");
  }
}
