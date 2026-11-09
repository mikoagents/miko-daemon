import { vi } from "vitest";

import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";

import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshot } from "../agent/provider-snapshot-manager.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ProviderSnapshotManager,
} from "../agent/provider-snapshot-manager.js";
import { createStub } from "./class-mocks.js";

export interface ProviderSnapshotManagerSpies {
  getSnapshot: ReturnType<typeof vi.fn<ProviderSnapshotManager["getSnapshot"]>>;
  refreshSnapshotForCwd: ReturnType<typeof vi.fn<ProviderSnapshotManager["refreshSnapshotForCwd"]>>;
  refreshSettingsSnapshot: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["refreshSettingsSnapshot"]>
  >;
  warmUpSnapshotForCwd: ReturnType<typeof vi.fn<ProviderSnapshotManager["warmUpSnapshotForCwd"]>>;
  listRegisteredProviderIds: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["listRegisteredProviderIds"]>
  >;
  hasProvider: ReturnType<typeof vi.fn<ProviderSnapshotManager["hasProvider"]>>;
  getProviderLabel: ReturnType<typeof vi.fn<ProviderSnapshotManager["getProviderLabel"]>>;
  getAgentManagerProviderState: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["getAgentManagerProviderState"]>
  >;
  listProviders: ReturnType<typeof vi.fn<ProviderSnapshotManager["listProviders"]>>;
  getProvider: ReturnType<typeof vi.fn<ProviderSnapshotManager["getProvider"]>>;
  validateAgentConfiguration: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["validateAgentConfiguration"]>
  >;
  listModels: ReturnType<typeof vi.fn<ProviderSnapshotManager["listModels"]>>;
  listModes: ReturnType<typeof vi.fn<ProviderSnapshotManager["listModes"]>>;
  resolveCreateConfig: ReturnType<typeof vi.fn<ProviderSnapshotManager["resolveCreateConfig"]>>;
  resolveDefaultModel: ReturnType<typeof vi.fn<ProviderSnapshotManager["resolveDefaultModel"]>>;
  getProviderDiagnostic: ReturnType<typeof vi.fn<ProviderSnapshotManager["getProviderDiagnostic"]>>;
  applyMutableProviderConfig: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["applyMutableProviderConfig"]>
  >;
  destroy: ReturnType<typeof vi.fn<ProviderSnapshotManager["destroy"]>>;
}

export function createProviderSnapshotManagerStub(): {
  manager: ProviderSnapshotManager;
} & ProviderSnapshotManagerSpies {
  const getSnapshot = vi.fn<ProviderSnapshotManager["getSnapshot"]>((cwd) =>
    createProviderSnapshot([], cwd),
  );
  const refreshSnapshotForCwd = vi.fn<ProviderSnapshotManager["refreshSnapshotForCwd"]>(
    async () => {},
  );
  const refreshSettingsSnapshot = vi.fn<ProviderSnapshotManager["refreshSettingsSnapshot"]>(
    async () => {},
  );
  const warmUpSnapshotForCwd = vi.fn<ProviderSnapshotManager["warmUpSnapshotForCwd"]>(
    async () => {},
  );
  const listRegisteredProviderIds = vi.fn<ProviderSnapshotManager["listRegisteredProviderIds"]>(
    () => [],
  );
  const hasProvider = vi.fn<ProviderSnapshotManager["hasProvider"]>(() => false);
  const getProviderLabel = vi.fn<ProviderSnapshotManager["getProviderLabel"]>((provider) => {
    try {
      return getAgentProviderDefinition(provider).label;
    } catch {
      return provider;
    }
  });
  const getAgentManagerProviderState = vi.fn<
    ProviderSnapshotManager["getAgentManagerProviderState"]
  >(() => ({
    providerDefinitions: {},
    clients: {},
  }));
  const listProviders = vi.fn<ProviderSnapshotManager["listProviders"]>(async () => []);
  const getProvider = vi.fn<ProviderSnapshotManager["getProvider"]>(async () => {
    throw new Error("createProviderSnapshotManagerStub: getProvider not stubbed");
  });
  const validateAgentConfiguration = vi.fn<ProviderSnapshotManager["validateAgentConfiguration"]>(
    async () => [],
  );
  const listModels = vi.fn<ProviderSnapshotManager["listModels"]>(async () => []);
  const listModes = vi.fn<ProviderSnapshotManager["listModes"]>(async () => []);
  const resolveCreateConfig = vi.fn<ProviderSnapshotManager["resolveCreateConfig"]>(async () => ({
    modeId: undefined,
    featureValues: undefined,
  }));
  const resolveDefaultModel = vi.fn<ProviderSnapshotManager["resolveDefaultModel"]>(
    async () => undefined,
  );
  const getProviderDiagnostic = vi.fn<ProviderSnapshotManager["getProviderDiagnostic"]>(
    async (provider) => ({ provider, diagnostic: "No diagnostic available for this provider." }),
  );
  const applyMutableProviderConfig = vi.fn<ProviderSnapshotManager["applyMutableProviderConfig"]>(
    () => ({
      providerDefinitions: {},
      clients: {},
    }),
  );
  const on = vi.fn();
  const off = vi.fn();
  const destroy = vi.fn<ProviderSnapshotManager["destroy"]>();
  const stub = {
    getSnapshot,
    refreshSnapshotForCwd,
    refreshSettingsSnapshot,
    warmUpSnapshotForCwd,
    listRegisteredProviderIds,
    hasProvider,
    getProviderLabel,
    getAgentManagerProviderState,
    listProviders,
    getProvider,
    validateAgentConfiguration,
    listModels,
    listModes,
    resolveCreateConfig,
    resolveDefaultModel,
    getProviderDiagnostic,
    applyMutableProviderConfig,
    on,
    off,
    destroy,
  };
  on.mockImplementation(() => stub);
  off.mockImplementation(() => stub);
  const manager = createStub<ProviderSnapshotManager>(stub);
  return {
    manager,
    getSnapshot,
    refreshSnapshotForCwd,
    refreshSettingsSnapshot,
    warmUpSnapshotForCwd,
    listRegisteredProviderIds,
    hasProvider,
    getProviderLabel,
    getAgentManagerProviderState,
    listProviders,
    getProvider,
    validateAgentConfiguration,
    listModels,
    listModes,
    resolveCreateConfig,
    resolveDefaultModel,
    getProviderDiagnostic,
    applyMutableProviderConfig,
    destroy,
  };
}

export function createProviderSnapshot(
  entries: ProviderSnapshotEntry[],
  cwd = GLOBAL_PROVIDER_SNAPSHOT_KEY,
): ProviderSnapshot {
  return {
    cwd,
    records: entries.map((entry) => {
      const { fetchedAt: _fetchedAt, ...content } = entry;
      return { entry, contentHash: JSON.stringify(content) };
    }),
  };
}
