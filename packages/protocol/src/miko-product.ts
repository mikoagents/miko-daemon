/** Fork identity and defaults. Native protocol names and internal symbols stay upstream-owned. */
export const MIKO_PRODUCT = {
  name: "Miko",
  command: "miko",
  homeDirectory: ".miko",
  port: 7767,
  relayEnabled: false,
  speechEnabled: false,
} as const;
