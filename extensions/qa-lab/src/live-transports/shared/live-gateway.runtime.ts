// Qa Lab plugin module implements live gateway behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  startQaGatewayChild,
  type QaCliBackendAuthMode,
  type QaGatewayChildCommand,
} from "../../gateway-child.js";
import { redactQaGatewayDebugText } from "../../gateway-log-redaction.js";
import type { QaProviderMode } from "../../model-selection.js";
import { startQaProviderServer } from "../../providers/server-runtime.js";
import type { QaThinkingLevel } from "../../qa-gateway-config.js";
import { appendQaLiveLaneIssue as appendLiveLaneIssue } from "./live-artifacts.js";

async function stopQaLiveLaneResources(
  resources: {
    gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
    mock: { baseUrl: string; stop(): Promise<void> } | null;
  },
  opts?: { keepTemp?: boolean; preserveToDir?: string },
) {
  const errors: string[] = [];
  try {
    await resources.gateway.stop(opts);
  } catch (error) {
    appendLiveLaneIssue(errors, "gateway stop failed", error);
  }
  if (resources.mock) {
    if (opts?.preserveToDir) {
      await preserveQaMockProviderDebugArtifacts(resources.mock, opts.preserveToDir, errors);
    }
    try {
      await resources.mock.stop();
    } catch (error) {
      appendLiveLaneIssue(errors, "mock provider stop failed", error);
    }
  }
  if (errors.length > 0) {
    throw new Error(`failed to stop QA live lane resources:\n${errors.join("\n")}`);
  }
}

async function preserveQaMockProviderDebugArtifacts(
  mock: { baseUrl: string },
  preserveToDir: string,
  errors: string[],
) {
  await fs.mkdir(preserveToDir, { recursive: true }).catch((error: unknown) => {
    appendLiveLaneIssue(errors, "mock provider debug artifact mkdir failed", error);
  });
  const artifacts = [
    { endpoint: "/debug/requests", fileName: "mock-provider-debug-requests.json" },
    { endpoint: "/debug/last-request", fileName: "mock-provider-debug-last-request.json" },
  ];
  for (const artifact of artifacts) {
    try {
      const response = await fetch(`${mock.baseUrl}${artifact.endpoint}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const raw = await response.text();
      await fs.writeFile(
        path.join(preserveToDir, artifact.fileName),
        formatQaMockProviderDebugArtifact(raw),
      );
    } catch (error) {
      appendLiveLaneIssue(
        errors,
        `mock provider debug artifact ${artifact.fileName} failed`,
        error,
      );
    }
  }
}

const QA_MOCK_PROVIDER_DEBUG_TEXT_KEYS = new Set([
  "allInputText",
  "arguments",
  "content",
  "input",
  "instructions",
  "messages",
  "partial_json",
  "plannedToolArgs",
  "prompt",
  "raw",
  "system",
  "text",
  "toolOutput",
]);

function formatQaMockProviderDebugArtifact(raw: string) {
  const secretRedacted = redactQaGatewayDebugText(raw);
  try {
    return `${JSON.stringify(redactQaMockProviderDebugValue(JSON.parse(secretRedacted)), null, 2)}\n`;
  } catch {
    return `${secretRedacted}\n`;
  }
}

function redactQaMockProviderDebugValue(value: unknown, key?: string): unknown {
  if (key && QA_MOCK_PROVIDER_DEBUG_TEXT_KEYS.has(key)) {
    return redactQaMockProviderDebugPayload(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactQaMockProviderDebugValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactQaMockProviderDebugValue(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value === "string") {
    return redactQaGatewayDebugText(value);
  }
  return value;
}

function redactQaMockProviderDebugPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return `<redacted ${value.length} item(s)>`;
  }
  if (value && typeof value === "object") {
    return "<redacted object>";
  }
  if (typeof value === "string") {
    return "<redacted>";
  }
  return value;
}

function omitMemoryCoreEntry<T extends Record<string, unknown> | undefined>(entries: T): T {
  if (!entries || !Object.hasOwn(entries, "memory-core")) {
    return entries;
  }
  const { "memory-core": _memoryCore, ...rest } = entries;
  return rest as T;
}

function prepareLiveTransportGatewayConfig(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults ?? {};
  return {
    ...cfg,
    plugins: cfg.plugins
      ? {
          ...cfg.plugins,
          allow: cfg.plugins.allow?.filter((pluginId) => pluginId !== "memory-core"),
          entries: omitMemoryCoreEntry(cfg.plugins.entries),
          slots: {
            ...cfg.plugins.slots,
            memory: "none",
          },
        }
      : {
          slots: {
            memory: "none",
          },
        },
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        memorySearch: {
          ...defaults.memorySearch,
          enabled: false,
          sync: {
            ...defaults.memorySearch?.sync,
            onSearch: false,
            onSessionStart: false,
            watch: false,
          },
        },
      },
    },
  };
}

export async function startQaLiveLaneGateway(params: {
  repoRoot: string;
  command?: QaGatewayChildCommand;
  transport: {
    requiredPluginIds: readonly string[];
    createGatewayConfig: (params: {
      baseUrl: string;
    }) => Pick<OpenClawConfig, "channels" | "messages">;
  };
  transportBaseUrl: string;
  controlUiAllowedOrigins?: string[];
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  controlUiEnabled?: boolean;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}) {
  const mock = await startQaProviderServer(params.providerMode);
  try {
    const gateway = await startQaGatewayChild({
      repoRoot: params.repoRoot,
      command: params.command,
      providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
      transport: params.transport,
      transportBaseUrl: params.transportBaseUrl,
      controlUiAllowedOrigins: params.controlUiAllowedOrigins,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      fastMode: params.fastMode,
      thinkingDefault: params.thinkingDefault,
      claudeCliAuthMode: params.claudeCliAuthMode,
      controlUiEnabled: params.controlUiEnabled,
      mutateConfig: (cfg) =>
        prepareLiveTransportGatewayConfig(params.mutateConfig ? params.mutateConfig(cfg) : cfg),
    });
    return {
      gateway,
      mock,
      async stop(opts?: { keepTemp?: boolean; preserveToDir?: string }) {
        await stopQaLiveLaneResources({ gateway, mock }, opts);
      },
    };
  } catch (error) {
    await mock?.stop().catch(() => {});
    throw error;
  }
}
