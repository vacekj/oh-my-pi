import { getModelsConfigSchemaBundle } from "./models-config-schema-bundle";

export const {
	OpenAICompatSchema,
	ModelOverrideSchema,
	ProviderDiscoverySchema,
	ProviderAuthSchema,
	ProviderBudgetSchema,
	ModelsConfigSchema,
} = getModelsConfigSchemaBundle();

export type ModelOverride = typeof ModelOverrideSchema.infer;
export type ProviderAuthMode = typeof ProviderAuthSchema.infer;
export type ProviderBudget = typeof ProviderBudgetSchema.infer;
export type ProviderDiscovery = typeof ProviderDiscoverySchema.infer;
export type ModelsConfig = typeof ModelsConfigSchema.infer;
