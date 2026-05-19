import sharp from "sharp";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DEVICES, type AppleDevice } from "../src/lib/pwa/devices";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const SOURCE_LOGO = join(PUBLIC_DIR, "pinchy-logo.png");
const SPLASH_DIR = join(PUBLIC_DIR, "splash");
const MASKABLE_OUT = join(PUBLIC_DIR, "icon-maskable-512.png");

const BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };

async function ensureDirs() {
  if (!existsSync(SPLASH_DIR)) {
    await mkdir(SPLASH_DIR, { recursive: true });
  }
}

async function generateSplash(device: AppleDevice, orientation: "portrait" | "landscape") {
  const width = orientation === "portrait" ? device.physicalWidth : device.physicalHeight;
  const height = orientation === "portrait" ? device.physicalHeight : device.physicalWidth;

  // Logo at 40% of the shorter edge, centered.
  const logoSize = Math.round(Math.min(width, height) * 0.4);
  const logoBuf = await sharp(SOURCE_LOGO)
    .resize(logoSize, logoSize, { fit: "contain", background: BACKGROUND })
    .png()
    .toBuffer();

  const outPath = join(SPLASH_DIR, `${device.slug}-${orientation}.png`);
  await sharp({
    create: { width, height, channels: 4, background: BACKGROUND },
  })
    .composite([{ input: logoBuf, gravity: "center" }])
    .png()
    .toFile(outPath);

  console.log(`  ${device.slug}-${orientation}: ${width}×${height} → ${outPath}`);
}

async function generateMaskableIcon() {
  // Maskable icons need ~20% safe-zone padding; render logo at 60% of 512px on white.
  const logoSize = Math.round(512 * 0.6);
  const logoBuf = await sharp(SOURCE_LOGO)
    .resize(logoSize, logoSize, { fit: "contain", background: BACKGROUND })
    .png()
    .toBuffer();

  await sharp({
    create: { width: 512, height: 512, channels: 4, background: BACKGROUND },
  })
    .composite([{ input: logoBuf, gravity: "center" }])
    .png()
    .toFile(MASKABLE_OUT);

  console.log(`  icon-maskable-512: 512×512 → ${MASKABLE_OUT}`);
}

async function main() {
  await ensureDirs();
  console.log(`Generating splash screens (${DEVICES.length} devices × 2 orientations):`);
  for (const device of DEVICES) {
    await generateSplash(device, "portrait");
    await generateSplash(device, "landscape");
  }
  console.log(`Generating maskable icon:`);
  await generateMaskableIcon();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
