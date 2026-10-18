/**
 * dsh-huaweicloud-connect 公开类型。
 *
 * 插件主体是 Cordis Host 插件；这里只描述导出面，避免调用方猜。
 */

/** 凭据读取失败的闭集原因码。 */
export type CredentialErrorCode =
  | "NOT_FOUND"
  | "UNREADABLE"
  | "UNRECOGNIZED"
  | "ENCRYPTED_UNSUPPORTED"
  | "HELPER_FAILED"
  | "EXPIRED_NO_REFRESH";

/** 上游请求失败的原因码。 */
export type UpstreamReasonCode = "UPSTREAM_ERROR" | "AUTH_FAILED" | "RATE_LIMITED" | "TOKEN_EXPIRED" | "SIGNED_OUT";

/** 单个模型的接入描述（驱动器的输出形态）。 */
export interface DriverModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: Array<"text" | "image">;
  reasoning?: boolean;
}

/** 驱动器统一接口。 */
export interface ProductDriver {
  product: string;
  displayName: string;
  providerId: string;
  envOverride: string;
  candidates(): Promise<string[]>;
  readCredential?(path: string): Promise<Record<string, unknown>>;
  parseAuth?(text: string): { kind: "plaintext" | "encrypted" | "unrecognized"; [key: string]: unknown } | undefined;
  fallbackModels: DriverModel[];
  listModels(credential: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<DriverModel[]>;
  chat(
    credential: Record<string, unknown>,
    body: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<{ status: number; headers: Record<string, string>; stream: AsyncIterable<Uint8Array> }>;
}

/** 插件 Config（与 lib/index.js 的 schemastery 定义一一对应）。 */
export interface HuaweiCloudConnectConfig {
  enableCodeArts: boolean;
  enableOfficeAce: boolean;
  authFileCodeArts: string;
  authFileOfficeAce: string;
  pollIntervalSeconds: number;
}

/** Cordis 插件名。 */
export declare const name: "llm-huaweicloud";
/** Cordis 注入声明。 */
export declare const inject: ["llm"];
/** 配置 schema。 */
export declare const Config: unknown;
/** Cordis 入口。 */
export declare function apply(ctx: unknown, config: HuaweiCloudConnectConfig): void;
