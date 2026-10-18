/**
 * @deepseek-ai/dsh-llm-pi-ai 的离线替身（仅测试台用）。
 *
 * 目标不是复刻内核，而是让「插件代码原样加载 → 注册 → 拉到模型 → 发一次流式请求」
 * 这条链路在 DSH 之外可跑，从而暴露插件自身的问题。
 *
 * 实现依据是 DSH 0.2.1-rc.2 里被验证过的真实契约：
 *   构造：new PiAiAdapter({ profiles, auth, resolveApiKey, resolveAttachments?, resolveImageAccess? })
 *   profile：{ provider, displayName, streamIdleTimeoutMs, retryPolicy,
 *              configuredMaxTokens, modelErrors, 图片预算三件套, piProvider }
 *   方法：listModels(provider) / resolveModel(provider, model) / prepareCall(...) / stream(options)
 *
 * LlmResolvedModelInfo 的形状（来自 INSPECT(llm) 契约）：
 *   { provider, id, name, context:{contextWindow}, defaultMaxTokens, inputModalities, reasoning }
 */

export class PiAiAdapter {
  constructor(options) {
    this.options = options;
    if (typeof options?.profiles !== "function") throw new TypeError("PiAiAdapter: profiles() 必需");
    if (typeof options?.resolveApiKey !== "function") throw new TypeError("PiAiAdapter: resolveApiKey() 必需");
  }

  #profile(provider) {
    const profiles = this.options.profiles();
    const profile = profiles?.get(provider);
    if (profile === undefined) throw new Error(`PiAiAdapter: 未知 provider ${provider}`);
    return profile;
  }

  /** 把 pi-ai descriptor 映射成 DSH 的模型信息。 */
  #toModelInfo(provider, model) {
    const efforts = [];
    if (model.reasoning === true) {
      const map = model.thinkingLevelMap ?? {};
      for (const [label, wire] of Object.entries(map)) {
        if (wire === null || wire === undefined) continue;
        efforts.push({ id: wire, name: label });
      }
    }
    return {
      provider,
      id: model.id,
      name: model.name,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      inputModalities: Array.isArray(model.input) ? model.input : ["text"],
      reasoning: efforts.length > 0 ? { efforts, defaultEffort: efforts[0]?.id } : undefined,
    };
  }

  providerInfo(provider) {
    const profile = this.#profile(provider);
    return { id: provider, name: profile.displayName ?? provider };
  }

  providerRetryPolicy(provider) {
    return this.#profile(provider).retryPolicy;
  }

  async listModels(provider) {
    const profile = this.#profile(provider);
    const models = profile.piProvider?.getModels?.() ?? profile.piProvider?.models ?? [];
    return models.map((model) => this.#toModelInfo(provider, model));
  }

  async resolveModel(provider, model) {
    const models = await this.listModels(provider);
    const found = models.find((row) => row.id === model);
    if (found === undefined) throw new Error(`PiAiAdapter: 模型未找到 ${provider}/${model}`);
    return found;
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    const profile = this.#profile(provider);
    const apiKey = await this.options.resolveApiKey(provider, model);
    if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("PiAiAdapter: 缺少 apiKey");
    return { provider, model: resolved, apiKey, profile };
  }

  /**
   * 流式请求。
   *
   * 分工说明：真实内核的 `PiAiAdapter.stream` 是 DSH 自带的宿主行为，本插件**不实现**
   * 它（插件只负责组装 profile 与 piProvider）。这里用 pi-ai 的**真实** `createModels()`
   * → `stream()` 跑通协议层，目的是验证插件交付的三样东西确实成立：
   *   1. pi-ai 接受插件产出的 Provider/descriptor
   *   2. descriptor 的 baseUrl / apiKey / compat 被真实客户端按预期使用
   *   3. 插件的 shim 与真实上游之间协议一致（能拿到正常 SSE 帧）
   */
  async *stream(options) {
    const provider = options.provider ?? options.profile?.provider;
    const modelId = options.model ?? options.profile?.model?.id;
    const prepared = await this.prepareCall(provider, modelId);
    const piProvider = prepared.profile.piProvider;

    // descriptor 必须从 getModels() 现取：插件每次调用都重建（shim 端口与目录都可能变）
    const descriptor = (piProvider.getModels?.() ?? piProvider.models ?? []).find((row) => row.id === modelId);
    if (descriptor === undefined) throw new Error(`PiAiAdapter: descriptor 缺失 ${provider}/${modelId}`);

    const { createModels, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    if (this.#models === undefined) {
      // pi-ai 的凭据必须在 createModels 时通过 CredentialStore 注入，事后没有 setter。
      // 这里用内存 store 存 shim 的随机 token：它每进程轮换、只对 127.0.0.1 有效。
      const credentials = new InMemoryCredentialStore();
      await credentials.modify(piProvider.id, async () => ({ type: "api_key", key: prepared.apiKey }));
      const models = createModels({ credentials });
      models.setProvider(piProvider);
      this.#models = models;
      this.#credentials = credentials;
    }

    const stream = this.#models.stream(descriptor, {
      systemPrompt: [],
      messages: options.messages ?? [],
    });
    for await (const event of stream) {
      yield { type: "raw", event };
    }
  }

  #models;
  #credentials;
}
