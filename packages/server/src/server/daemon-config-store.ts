import { ProviderOverrideSchema, type ProviderOverride } from "./agent/provider-launch-config.js";
export type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
export function applyMutableProviderConfigToOverrides(
  baseOverrides: Record<string, ProviderOverride> | undefined,
  mutableProviders: MutableDaemonConfig["providers"] | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!baseOverrides && (!mutableProviders || Object.keys(mutableProviders).length === 0)) {
    return undefined;
  }

  const nextOverrides: Record<string, ProviderOverride> = { ...baseOverrides };
  for (const [providerId, providerConfig] of Object.entries(mutableProviders ?? {})) {
    const previousOverride = nextOverrides[providerId];
    const parsedOverride = ProviderOverrideSchema.strip().parse(providerConfig);
    nextOverrides[providerId] = {
      ...previousOverride,
      ...parsedOverride,
      ...(parsedOverride.paseoTools
        ? {
            paseoTools: {
              ...previousOverride?.paseoTools,
              ...parsedOverride.paseoTools,
            },
          }
        : {}),
    };
  }

  return nextOverrides;
}
