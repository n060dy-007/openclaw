// Qa Lab tests cover live gateway plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startQaGatewayChild, startQaProviderServer } = vi.hoisted(() => ({
  startQaGatewayChild: vi.fn(),
  startQaProviderServer: vi.fn(),
}));

vi.mock("../../gateway-child.js", () => ({
  startQaGatewayChild,
}));

vi.mock("../../providers/server-runtime.js", () => ({
  startQaProviderServer,
}));

import { startQaLiveLaneGateway } from "./live-gateway.runtime.js";

type GatewayOptions = {
  providerBaseUrl?: string;
  providerMode?: string;
  transportBaseUrl?: string;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
};

function createStubTransport(baseUrl = "http://127.0.0.1:43123") {
  return {
    requiredPluginIds: ["qa-channel"],
    createGatewayConfig: () => ({
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
        },
      },
    }),
  };
}

function firstGatewayOptions(): GatewayOptions | undefined {
  return startQaGatewayChild.mock.calls[0]?.[0] as GatewayOptions | undefined;
}

describe("startQaLiveLaneGateway", () => {
  const gatewayStop = vi.fn();
  const gatewayCall = vi.fn();
  const mockStop = vi.fn();

  beforeEach(() => {
    gatewayStop.mockReset();
    gatewayCall.mockReset();
    mockStop.mockReset();
    startQaGatewayChild.mockReset();
    startQaProviderServer.mockReset();

    startQaGatewayChild.mockResolvedValue({
      call: gatewayCall,
      cfg: {},
      stop: gatewayStop,
    });
    startQaProviderServer.mockImplementation(async (providerMode: string) =>
      providerMode === "mock-openai"
        ? {
            baseUrl: "http://127.0.0.1:44080",
            stop: mockStop,
          }
        : null,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("threads the mock provider base url into the gateway child", async () => {
    const harness = await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      controlUiEnabled: false,
    });

    expect(startQaProviderServer).toHaveBeenCalledWith("mock-openai");
    const gatewayOptions = firstGatewayOptions();
    expect(gatewayOptions?.transportBaseUrl).toBe("http://127.0.0.1:43123");
    expect(gatewayOptions?.providerBaseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(gatewayOptions?.providerMode).toBe("mock-openai");

    await harness.stop();
    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("disables memory search for transport-only live lanes", async () => {
    await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      controlUiEnabled: false,
    });

    const { mutateConfig } = firstGatewayOptions() ?? {};
    if (!mutateConfig) {
      throw new Error("expected gateway config mutator");
    }
    const cfg = mutateConfig({
      plugins: {
        allow: ["acpx", "memory-core", "qa-channel"],
        entries: {
          acpx: { enabled: true },
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
        slots: {
          memory: "memory-core",
          contextEngine: "qmd",
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            sync: {
              onSearch: true,
              onSessionStart: true,
              watch: true,
            },
          },
        },
      },
    });

    expect(cfg?.plugins?.allow).toEqual(["acpx", "qa-channel"]);
    expect(cfg?.plugins?.entries).not.toHaveProperty("memory-core");
    expect(cfg?.plugins?.slots?.memory).toBe("none");
    expect(cfg?.plugins?.slots?.contextEngine).toBe("qmd");
    expect(cfg?.agents?.defaults?.memorySearch?.enabled).toBe(false);
    expect(cfg?.agents?.defaults?.memorySearch?.sync?.onSearch).toBe(false);
    expect(cfg?.agents?.defaults?.memorySearch?.sync?.onSessionStart).toBe(false);
    expect(cfg?.agents?.defaults?.memorySearch?.sync?.watch).toBe(false);
  });

  it("forwards gateway stop options to the child harness", async () => {
    const preserveToDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-live-gateway-debug-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          raw: '{"input":"SECRET_PROMPT"}',
          body: {
            input: [{ role: "user", content: "SECRET_PROMPT" }],
            model: "mock-openai/gpt-5.5",
          },
          prompt: "SECRET_PROMPT",
          allInputText: "SECRET_PROMPT",
          instructions: "SECRET_SYSTEM",
          plannedToolArgs: { command: "SECRET_COMMAND" },
          model: "mock-openai/gpt-5.5",
          providerVariant: "openai",
        }),
    } as Response);
    const harness = await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      controlUiEnabled: false,
    });

    try {
      await harness.stop({ preserveToDir });
      expect(gatewayStop).toHaveBeenCalledWith({ preserveToDir });
      expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:44080/debug/requests");
      expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:44080/debug/last-request");
      expect(
        await fs.readFile(path.join(preserveToDir, "mock-provider-debug-requests.json"), "utf8"),
      ).toContain('"model": "mock-openai/gpt-5.5"');
      const lastRequestArtifact = await fs.readFile(
        path.join(preserveToDir, "mock-provider-debug-last-request.json"),
        "utf8",
      );
      expect(lastRequestArtifact).toContain('"model": "mock-openai/gpt-5.5"');
      expect(lastRequestArtifact).toContain('"providerVariant": "openai"');
      expect(lastRequestArtifact).toContain('"prompt": "<redacted>"');
      expect(lastRequestArtifact).toContain('"input": "<redacted 1 item(s)>"');
      expect(lastRequestArtifact).not.toContain("SECRET_PROMPT");
      expect(lastRequestArtifact).not.toContain("SECRET_SYSTEM");
      expect(lastRequestArtifact).not.toContain("SECRET_COMMAND");
      expect(mockStop).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      await fs.rm(preserveToDir, { recursive: true, force: true });
    }
  });

  it("skips mock bootstrap for live frontier runs", async () => {
    const harness = await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5",
      controlUiEnabled: false,
    });

    expect(startQaProviderServer).toHaveBeenCalledWith("live-frontier");
    const gatewayOptions = firstGatewayOptions();
    expect(gatewayOptions?.transportBaseUrl).toBe("http://127.0.0.1:43123");
    expect(gatewayOptions?.providerBaseUrl).toBeUndefined();
    expect(gatewayOptions?.providerMode).toBe("live-frontier");

    await harness.stop();
    expect(gatewayStop).toHaveBeenCalledTimes(1);
  });

  it("still stops the mock server when gateway shutdown fails", async () => {
    gatewayStop.mockRejectedValueOnce(new Error("gateway down"));
    const harness = await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      controlUiEnabled: false,
    });

    await expect(harness.stop()).rejects.toThrow(
      "failed to stop QA live lane resources:\ngateway stop failed: gateway down",
    );
    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("reports both gateway and mock shutdown failures together", async () => {
    gatewayStop.mockRejectedValueOnce(new Error("gateway down"));
    mockStop.mockRejectedValueOnce(new Error("mock down"));
    const harness = await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      controlUiEnabled: false,
    });

    await expect(harness.stop()).rejects.toThrow(
      "failed to stop QA live lane resources:\ngateway stop failed: gateway down\nmock provider stop failed: mock down",
    );
  });
});
