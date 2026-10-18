## 首个版本

把**华为云 CodeArts（码道）** 与 **OfficeAce（果办）** 桌面客户端里已经登录的模型接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

设计思路沿用 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)：
**复用客户端自己的登录态**，不做额外 OAuth，不读取也不保存用户口令。

### 已实测验证

| | OfficeAce | CodeArts |
|---|---|---|
| 凭据读取 | ✅ 本地明文 JSON | ✅ `state.vscdb` 明文（`node:sqlite`） |
| 模型目录 | ✅ 21 个 | ✅ 7 个 |
| 鉴权 | ✅ `Authorization: Basic` | ✅ APIG `SDK-HMAC-SHA256` 签名，服务端返回 200 |
| **真实流式对话** | ✅ **通过** | ✅ **通过** |

测试 94 项全通过（签名规范、请求归一化、凭据状态机、Web 路由与回环闸、客户端 slot 注册与降级守卫）。

### 架构

```
PiAiAdapter(pi-ai) ↔ 回环 shim(OpenAI 兼容) ↔ 华为云私有 HTTP
```

厂商差异全部收敛在 shim 与驱动器里，pi-ai 只看见一个干净的 OpenAI endpoint。

### 两个刻意的设计

**1. 绝不刷新登录态**

两个产品的 `refresh_token` 都是一次性轮换的：

- OfficeAce：插件若自行续期会与客户端抢，触发 `STS5.1806` **把用户登出**
- CodeArts：`refresh_token` 绑定 `client_id=codearts-agent` 且需要客户端手里的 DPoP 私钥

所以插件只读凭据、只检查 `expiresAt`，过期时提示「请打开客户端让它自动续期」。

**2. 不给模型编造推理档位**

上游没有稳定声明哪些 `reasoning_effort` 真正生效，且实测部分模型会**接受但忽略**
未知值——一次 200 不能证明该档位可用。因此对全部模型声明 `reasoning: false`，
不提供档位选择。

### 一个值得记录的坑：CodeArts 的模型目录不能信接口返回

`/v1/model/builtin` 返回的 7 个模型**全部不能用于对话**——逐个发真实请求，
一律返回 `InferHub.4005.200 unsupported model`。IDE 下发的 `inferhub-provider`
只有 5 个，同样不含任何可用模型。真正可用的是客户端 `model-cache-hook` 记录过的那批。

本插件因此把 `/v1/model/builtin` 只当**探针**（验证凭据与签名是否正常），
可选模型另用实测集。`test/selftest.mjs` 里有 5 条断言锁死这个结论，防止后来者「好心」改回去。

### 安装

前置：本机已安装并**登录过** OfficeAce / CodeArts Agent 至少一次。

```sh
dsh plugin --profile desktop add dsh-huaweicloud-connect@0.1.0
# 或从源码
dsh plugin --profile desktop add github:Alanine-gH/dsh-huaweicloud-connect#v0.1.0
```

然后**完全退出并重启** DeepSeek Harness 桌面版。

### 设置界面

插件页 → `华为云模型接入`，两张卡片分别显示：

- 登录状态、账号、凭据剩余时长（分钟/小时/天）
- 模型目录来源（实时 / 内置兜底）
- 每个模型的显示勾选、全选/全不选、刷新按钮

模型显隐**按产品分别保存**，可切换成按账号记忆。

### 已知限制

- CodeArts 的 STS 约 1 小时有效，由客户端续期，插件不代劳
- CodeArts 有**并发会话上限 3 个**，客户端开着时占满名额
- OfficeAce 的 `models.json` 只在客户端跑过一次后落盘
- 上下文窗口是内置快照（两个上游的列表接口都不返回该字段）
- **「能列出来」≠「有权限」**：网关目录是全量目录

### 免责声明

依赖两个客户端**未公开**的内部接口，客户端更新后可能需要调整。
仅供个人学习与研究，驱动使用者自己的账号在本机调用。
与华为云无关联，商标权归各自所有。