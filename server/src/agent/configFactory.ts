// opencode.json 配置工厂（移植自桌面 client/electron/services/opencode/opencodeConfigFactory.cjs）。
// 唯一职责：把 proxyBaseUrl / context 长度 / 超时 形变成 opencode 能识别的 provider 配置字面量。
// provider `yibiao` 指向本进程内 AI proxy（127.0.0.1:<proxyPort>/v1），apiKey 用占位
// `{env:YIBIAO_OPENCODE_PROXY_TOKEN}`——opencode 会在 spawn 时从 env 解析真实 token。

import fs from 'node:fs';
import path from 'node:path';

export interface OpenCodeConfigInput {
  proxyBaseUrl: string;
  contextLengthLimit?: number | string;
  timeoutMs?: number | string;
}

export interface OpenCodeConfig {
  $schema: string;
  autoupdate: boolean;
  model: string;
  small_model: string;
  provider: {
    yibiao: {
      npm: string;
      name: string;
      options: {
        baseURL: string;
        apiKey: string;
        timeout: number;
      };
      models: {
        default: {
          name: string;
          limit: {
            context: number;
            output: number;
          };
        };
      };
    };
  };
}

export function normalizeContextLimit(value: number | string | undefined): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 400000;
}

export function normalizeOutputLimit(contextLengthLimit: number | string | undefined): number {
  const context = normalizeContextLimit(contextLengthLimit);
  return Math.max(32768, Math.floor(context * 0.5));
}

export function normalizeTimeoutMs(value: number | string | undefined, fallback = 300000): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function buildOpenCodeConfig(input: OpenCodeConfigInput): OpenCodeConfig {
  const providerTimeout = normalizeTimeoutMs(input.timeoutMs);
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    model: 'yibiao/default',
    small_model: 'yibiao/default',
    provider: {
      yibiao: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Yibiao AI',
        options: {
          baseURL: `${input.proxyBaseUrl}/v1`,
          apiKey: '{env:YIBIAO_OPENCODE_PROXY_TOKEN}',
          timeout: providerTimeout,
        },
        models: {
          default: {
            name: 'Yibiao Current Text Model',
            limit: {
              context: normalizeContextLimit(input.contextLengthLimit),
              output: normalizeOutputLimit(input.contextLengthLimit),
            },
          },
        },
      },
    },
  };
}

export function writeOpenCodeConfig(configPath: string, input: OpenCodeConfigInput): OpenCodeConfig {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = buildOpenCodeConfig(input);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}
