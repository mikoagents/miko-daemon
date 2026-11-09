import type { AgentProvider } from "./agent-sdk-types.js";
export interface ResolvedProviderModel {
  provider: AgentProvider;
  model: string | undefined;
}

export function resolveRequiredProviderModel(
  providerValue: string,
): Required<ResolvedProviderModel> {
  const providerInput = providerValue.trim();
  const slashIndex = providerInput.indexOf("/");
  if (slashIndex <= 0 || slashIndex === providerInput.length - 1) {
    throw new Error("provider must be provider/model, for example codex/gpt-5.4");
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const model = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    throw new Error("provider must be provider/model, for example codex/gpt-5.4");
  }

  return {
    provider: provider,
    model,
  };
}
