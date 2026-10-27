export const CONNECTOR_NAME = "agent-knock-knock-deepseek-harness";
export const CONNECTOR_PACKAGE =
  "@scotthuang/agent-knock-knock-deepseek-harness";
export const CONNECTOR_VERSION = "0.1.0-rc.14";

export const DSH_LAUNCHER_PACKAGE = "@deepseek-ai/dsh";
export const SUPPORTED_DSH_VERSIONS = Object.freeze([
  "0.1.1-rc.2",
  "0.1.2-alpha.1",
  "0.1.5-rc.2",
  "0.2.0-rc.2",
  "0.2.1-alpha.2",
  "0.2.1-rc.2",
] as const);
export type SupportedDeepSeekHarnessVersion =
  (typeof SUPPORTED_DSH_VERSIONS)[number];
export const DSH_RUNTIME_ANCHOR_PACKAGE = "@deepseek-ai/dsh-base";
export const SUPPORTED_DSH_RUNTIME_PACKAGES = Object.freeze([
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-commands",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-skill",
  "@deepseek-ai/dsh-tools",
] as const);
export const DSH_HOST_ID = "deepseek-harness";

export const CONTROLLER_ID_ENV = "AKK_DSH_CONTROLLER_ID";
export const CALLBACK_SOCKET_ENV = "AKK_DSH_CALLBACK_SOCKET";
export const CALLBACK_TOKEN_ENV = "AKK_DSH_CALLBACK_TOKEN";

export const HOST_PROFILE_SELECTION_ENV = "AKK_HOST_PROFILE_SELECTION";
export const HOST_PROFILE_SOURCE_ENV = "AKK_HOST_PROFILE_SOURCE";
export const HOST_PROFILE_FINGERPRINT_ENV = "AKK_HOST_PROFILE_FINGERPRINT";
export const HOST_PROFILE_HOST_ENV = "AKK_HOST_PROFILE_HOST";
export const HOST_PROFILE_HOST_VERSION_ENV = "AKK_HOST_PROFILE_HOST_VERSION";

export const CALLBACK_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const CALLBACK_MAX_RESPONSE_BYTES = 64 * 1024;
export const CALLBACK_TIMEOUT_MS = 8_000;
// Leave time for the helper to emit a retry acknowledgement before core's
// outer command deadline. Admission may still complete in the durable journal.
export const CALLBACK_IPC_TIMEOUT_MS = 6_000;
