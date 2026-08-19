// Pi json-validation 自定义工具（移植自桌面 electron/services/pi/piJsonValidationTool.cjs）。
// 用 JSON.parse + Ajv 校验 agent 写出的 JSON 文件是否符合预置/调用方提供的 JSON Schema。
// 依赖 ajv（Draft-07）。Type（typebox 构造器）由 piSessionFactory 注入，与 SDK 同源。

import fs from 'node:fs';
import path from 'node:path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

export const JSON_VALIDATION_TOOL_NAME = 'json-validation';

// typebox Type 构造器的最小结构形状（只列本工具用到的方法）。运行时对象由 piSessionFactory 注入。
export interface PiTypeBuilder {
  Object(schema: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  String(options?: Record<string, unknown>): unknown;
  Optional<T>(schema: T): T;
  Union(schemas: unknown[], options?: Record<string, unknown>): unknown;
  Array(schema: unknown, options?: Record<string, unknown>): unknown;
  Boolean(options?: Record<string, unknown>): unknown;
}

// 统一工作区相对路径，供文件读取和预置 Schema 匹配使用。
function normalizeWorkspaceFilePath(filePath: string): string {
  const relativePath = String(filePath ?? '').trim().replace(/\\/g, '/');
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('file_path 必须是当前工作区内的非空相对路径');
  }
  return path.posix.normalize(relativePath);
}

// 将 agent 提供的相对路径解析到当前工作区内（拒越界）。
function resolveWorkspaceFile(workspaceDir: string, filePath: string): { relativePath: string; resolvedPath: string } {
  const relativePath = normalizeWorkspaceFilePath(filePath);
  const workspaceRoot = path.resolve(workspaceDir);
  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`file_path 超出当前工作区：${filePath}`);
  }
  return { relativePath, resolvedPath };
}

// Ajv 错误 → agent 易于定位和修复的结构。
function normalizeAjvErrors(errors: ErrorObject[] | null | undefined): Array<Record<string, unknown>> {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath || '/',
    schemaPath: error.schemaPath || '',
    keyword: error.keyword || '',
    message: error.message || '字段不符合 JSON Schema',
    params: error.params || {},
  }));
}

interface ToolResultPayload {
  valid: boolean;
  stage: string;
  file_path: string;
  errors: unknown[];
  message: string;
}

// 生成统一的工具返回结果（pi 工具 content/details/isError 三段式）。
function createToolResult({
  filePath,
  valid,
  stage,
  errors = [],
}: {
  filePath: string;
  valid: boolean;
  stage: string;
  errors?: unknown[];
}) {
  const payload: ToolResultPayload = {
    valid,
    stage,
    file_path: filePath,
    errors,
    message: valid
      ? 'JSON.parse 和 Ajv 校验均已通过。'
      : '校验未通过，请根据 errors 修复文件后再次调用 json-validation。',
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
    ...(valid ? {} : { isError: true }),
  };
}

export interface PiJsonValidationTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: unknown;
  execute: (toolCallId: string, params: { file_path: string; schema?: object | boolean }) => Promise<ReturnType<typeof createToolResult>>;
}

// 创建只负责 JSON 解析与 Schema 校验的 pi 自定义工具。
export function createPiJsonValidationTool({
  workspaceDir,
  Type,
  validationSchemas = {},
}: {
  workspaceDir: string;
  Type: PiTypeBuilder;
  validationSchemas?: Record<string, object>;
}): PiJsonValidationTool {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const presetSchemas = new Map(
    Object.entries(validationSchemas).map(([filePath, schema]) => [normalizeWorkspaceFilePath(filePath), schema]),
  );

  return {
    name: JSON_VALIDATION_TOOL_NAME,
    label: 'JSON 校验',
    description:
      '使用 JSON.parse 和 Ajv 校验当前工作区内的 JSON 文件。任务已预置 Schema 时只传 file_path；没有预置时根据输出要求提供完整 schema。校验失败后修复文件并再次调用。',
    promptSnippet: '使用 JSON.parse 和 Ajv 校验工作区内的 JSON 文件。',
    parameters: Type.Object(
      {
        file_path: Type.String({
          minLength: 1,
          description: '待校验 JSON 文件相对于当前工作区的路径。',
        }),
        schema: Type.Optional(
          Type.Union(
            [
              Type.Object({}, { additionalProperties: true }),
              Type.Boolean(),
            ],
            {
              description: '仅在任务没有为目标文件预置 Schema 时提供，根据当前任务输出要求构造 JSON Schema Draft-07。',
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params) => {
      let source: string;
      let relativePath: string;
      try {
        const resolved = resolveWorkspaceFile(workspaceDir, params.file_path);
        relativePath = resolved.relativePath;
        source = fs.readFileSync(resolved.resolvedPath, 'utf-8');
      } catch (error) {
        return createToolResult({
          filePath: params.file_path,
          valid: false,
          stage: 'read',
          errors: [{ message: (error as Error)?.message || String(error) }],
        });
      }

      let data: unknown;
      try {
        data = JSON.parse(source);
      } catch (error) {
        return createToolResult({
          filePath: params.file_path,
          valid: false,
          stage: 'parse',
          errors: [{ message: (error as Error)?.message || String(error) }],
        });
      }

      let validate: ValidateFunction;
      try {
        const schema = presetSchemas.has(relativePath) ? presetSchemas.get(relativePath) : params.schema;
        if (schema === undefined) {
          throw new Error(`任务未为 ${relativePath} 预置 Schema，调用时必须提供 schema`);
        }
        validate = ajv.compile(schema as object);
      } catch (error) {
        return createToolResult({
          filePath: params.file_path,
          valid: false,
          stage: 'schema',
          errors: [{ message: (error as Error)?.message || String(error) }],
        });
      }

      if (!validate(data)) {
        return createToolResult({
          filePath: params.file_path,
          valid: false,
          stage: 'validation',
          errors: normalizeAjvErrors(validate.errors),
        });
      }

      return createToolResult({
        filePath: params.file_path,
        valid: true,
        stage: 'success',
      });
    },
  };
}
