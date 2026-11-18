#!/usr/bin/env node
// `node scripts/generate-browser-url-hosts.mjs` (from packages/web) — writes
// src/lib/approvals/browser-url-hosts.json: for every text below, the host
// Node's URL parser resolves and the host each browser's resolves, or null
// where one refuses it.
//
// The approval card names the host a URL reaches. Node's parser answers that
// for the tools; for a host Node refuses — a label such as `xn--a` that does
// not decode — the card reads the host itself (`urlHostAsWritten`), and a
// browser still opens it. Which texts a browser opens is a fact about
// browsers, not something to reason out of the spec, so it is measured here
// and the test checks the reading against it (`presentation.test.ts`).
//
// Needs the Playwright browsers (`pnpm exec playwright install chromium
// webkit`, or `CHROMIUM_EXECUTABLE` and `WEBKIT_EXECUTABLE` set to installed
// builds). Re-run after changing the corpus, and commit the JSON.
import { writeFileSync } from "node:fs";
import { chromium, webkit } from "@playwright/test";

const LONG = `www.firma.at.${"a".repeat(250)}`;

/** Hosts written into every shape: one Node refuses, and one everyone accepts. */
const HOSTS = ["xn--a.evil.com", "evil.com"];

/** `{h}` is replaced by each host. */
const SHAPES = [
  "https://{h}/x",
  "https://{h}",
  "https://{h}/x\ty",
  "https://{h}/x y",
  "https://{h}/x\u00a0y",
  "https://{h}/\u3000x",
  "https://{h}/ see above",
  "https://{h} see above",
  "https://{h}, see above",
  "https://{h}/\tx",
  `https://${LONG}@{h}/\tx`,
  `https://${LONG}@{h}/x y`,
  `https://${LONG}@{h}/x`,
  `https://${LONG}@{h}/ see above`,
  "ht\ttps://{h}/",
  "h\nttps://{h}/",
  "https:/\t/{h}/",
  "https://\n{h}/",
  "https://{h}\r\n/x",
  "https://{h}/\r\n",
  "  https://{h}/  ",
  "\u0001https://{h}/",
  "https://{h}/\u0001",
  "HTTPS://{h}/",
  "https:{h}/x",
  "https:/{h}/x",
  "https:\\\\{h}\\x",
  "https:///{h}/x",
  "https://{h}\\x",
  "https://{h}?q",
  "https://{h}#f",
  "https://{h}?q y",
  "https://{h}#f y",
  "https://u@{h}:8080/x",
  "https://u:p@{h}/x",
  "https://a@b@{h}/x",
  "https://@{h}/x",
  "https://u@/{h}",
  "https://{h}:/x",
  "https://{h}:443/x",
  "https://{h}:8\t080/x",
  "https://{h}:abc/x",
  "https://{h}:99999/x",
  "https://{h}:8080x/",
  "https://u\t@{h}/x",
  "https://u y@{h}/x",
  "https://{h}./x",
  "https://{h}\u3002/x",
  "https://{h}\uff0e/x",
  "https://{h}\u00a0/x",
  "https://{h}\u3000/x",
  "https://{h}\u2028/x",
  "https://{h}\u200b/x",
  "https://{h}\ufeff/x",
  "https://{h}%20/x",
  "https://{h}%00/x",
  "https://{h}\u0000/x",
  "https://{h}|/x",
  "https://{h}^/x",
  "https://{h}</x",
  "https://{h}%/x",
  "https://{h}_/x",
  "https://{h}*/x",
  "https://{h}!/x",
  "https://{h}$/x",
  "https://{h}'/x",
  "https://{h}(/x",
  "https://{h}~/x",
  "https://{h}=/x",
  'https://{h}"/x',
  "https://{h}`/x",
  "https://{h}{/x",
  "https://{h}}/x",
  "https://{h}&/x",
  "https://{h}+/x",
  "https://{h};/x",
  "https://{h},/x",
  "https://{h}\u007f/x",
  "https://{h}\u0080/x",
  "https://{h}\u00ad/x",
  "https://[{h}]/x",
  "https://{h}.1/x",
  "https://{h}.0x7f/x",
  "https://{h}.1.2/x",
  "http://{h}/x",
  "wss://{h}/x",
  "ws://{h}/x",
  "ftp://{h}/x",
  "file://{h}/x",
  "file:{h}",
  "file:/{h}",
  "file:///{h}",
  "file:\\\\{h}\\x",
  "file://u@{h}/x",
  "file://{h}:80/x",
  "mailto:boss@{h}",
  "foo://{h}/x",
  "javascript://{h}/x",
];

/** Labels and characters that sit inside the host itself. */
const HOST_ONLY = [
  "https://xn--a.ev\til.com/",
  "https://xn--a.ev\nil.com/",
  "https://xn--a.ev il.com/",
  "https://xn--a.evil%2Ecom/",
  "https://xn--a.evil%2ecom/x",
  "https://xn--a%2Eevil.com/x",
  "https://XN--A.Evil.com/x",
  "https://Xn--a.evil.com/x",
  "https://xn--.evil.com/x",
  "https://xn---.evil.com/x",
  "https://xn--ab-cd.evil.com/x",
  "https://xn--a.f\u0456rma.at/",
  "https://f\u0456rma.xn--a/",
  "https://xn--a.xn--frma-l9d.at/",
  "https://xn--a.firma.at/",
  "https://xn--a/",
  "https://xn--a.1/",
  "https://xn--a.0x7f.1/",
  "https://xn--a.evil.\u0441om/",
  "https://xn--a.ev\u200dil.com/",
  "https://xn--a.\u0627\u0644\u0639\u0631\u0628\u064a\u0629.com/",
  "https://xn--a.a\u0627.com/",
  "https://xn--a.-evil.com/",
  "https://xn--a.evil-.com/",
  "https://xn--a.ev--il.com/",
  `https://xn--a.${"a".repeat(64)}.com/`,
  `https://xn--a.${"a".repeat(63)}.com/`,
  "https://xn--a..evil.com/",
  "https://.xn--a.evil.com/",
  "https://xn--a.evil.com../",
  "https://xn--ls8h.xn--a/",
  "https://xn--a.\u2460.com/",
  "https://xn--a.\uff21.com/",
  "https://xn--a.\u00df.com/",
  "https://xn--a.\u03c2.com/",
  "https://xn--a.\u0301a.com/",
];

const corpus = [
  ...SHAPES.flatMap((shape) => HOSTS.map((host) => shape.replaceAll("{h}", host))),
  ...HOST_ONLY,
];

/** The host each text reaches in this engine, or null where it refuses one. */
function hostsIn(texts) {
  return texts.map((text) => {
    try {
      return new URL(text).hostname;
    } catch {
      return null;
    }
  });
}

const browsers = {};
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  // `CHROMIUM_EXECUTABLE` and the like point at an installed build when it is
  // not the revision this Playwright version expects.
  const executablePath = process.env[`${name.toUpperCase()}_EXECUTABLE`] || undefined;
  const browser = await engine.launch({ executablePath });
  const version = browser.version();
  const page = await browser.newPage();
  browsers[name] = { version, hosts: await page.evaluate(hostsIn, corpus) };
  await browser.close();
}

const rows = corpus.map((text, i) => ({
  text,
  node: hostsIn([text])[0],
  chromium: browsers.chromium.hosts[i],
  webkit: browsers.webkit.hosts[i],
}));

const out = new URL("../src/lib/approvals/browser-url-hosts.json", import.meta.url);
writeFileSync(
  out,
  `${JSON.stringify(
    {
      generatedBy: "packages/web/scripts/generate-browser-url-hosts.mjs",
      engines: {
        node: process.versions.node,
        chromium: browsers.chromium.version,
        webkit: browsers.webkit.version,
      },
      rows,
    },
    null,
    2
  )}\n`
);
console.log(`${rows.length} rows written to ${out.pathname}`);
