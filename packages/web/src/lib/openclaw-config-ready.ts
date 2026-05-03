let configReady = false;

export function markOpenClawConfigReady(): void {
  configReady = true;
}

export function isOpenClawConfigReady(): boolean {
  return configReady;
}
