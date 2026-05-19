import { DEVICES, type AppleDevice } from "@/lib/pwa/devices";

function mediaQuery(device: AppleDevice, orientation: "portrait" | "landscape") {
  return [
    `(device-width: ${device.logicalWidth}px)`,
    `(device-height: ${device.logicalHeight}px)`,
    `(-webkit-device-pixel-ratio: ${device.pixelRatio})`,
    `(orientation: ${orientation})`,
  ].join(" and ");
}

/**
 * Emits one `<link rel="apple-touch-startup-image">` per device per orientation.
 * iOS reads these on "Add to Home Screen" install. Without them, the launched
 * PWA shows a blank white screen instead of a branded splash.
 */
export function AppleSplashLinks() {
  return (
    <>
      {DEVICES.flatMap((device) =>
        (["portrait", "landscape"] as const).map((orientation) => (
          <link
            key={`${device.slug}-${orientation}`}
            rel="apple-touch-startup-image"
            href={`/splash/${device.slug}-${orientation}.png`}
            media={mediaQuery(device, orientation)}
          />
        ))
      )}
    </>
  );
}
