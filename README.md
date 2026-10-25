# dsh-huaweicloud-connect

把**华为云 CodeArts（码道）** 与 **OfficeAce（果办）** 桌面客户端里已经登录的模型接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

设计思路与 `dsh-workbuddy-connect` 一致：**复用客户端自己的登录态**，不做额外 OAuth，
不读取、不保存用户口令。

- OfficeAce 分组：直连华为云模型网关（21 个模型，含 DeepSeek-V4 / GLM-5.x / Kimi / Pangu / Qwen）
- CodeArts 分组：直连 `snap-access` 网关，走 APIG `SDK-HMAC-SHA256` 签名

> 状态：**两端均已端到端实测通过**。
> - OfficeAce：真实请求拿到 21 个模型，并完成一次真实流式对话（模型回复正常）。
> - CodeArts：凭据读取、APIG 签名（服务端返回 200）、模型目录、真实对话均已验证。
>
> CodeArts 的模型目录有一处**实测坑**，见下文「模型目录为什么不能信接口返回」。

---

## 为什么不是「填 API Key」

两个产品的鉴权都不是普通 Bearer：

| 产品 | 鉴权 | 说明 |
|---|---|---|
| OfficeAce | `Authorization: Basic base64(app_key:app_secret)` | APIG「APP 认证」，值已存在于本地明文文件 |
| CodeArts | `Authorization: SDK-HMAC-SHA256 Access=…, SignedHeaders=…, Signature=…` | 需 AK/SK + `X-Security-Token` 现算签名 |

所以插件用「回环 shim」结构：对 pi-ai 暴露一个标准 OpenAI endpoint，把签名/自定义头
收在 shim 内部。

```
PiAiAdapter(pi-ai) ↔ 127.0.0.1 回环 shim(OpenAI 兼容) ↔ 华为云私有 HTTP
```

---

## 安装

前置：本机已安装并**登录过** OfficeAce / CodeArts Agent 至少一次。

### 推荐：从 npm 安装

```sh
dsh plugin --profile desktop add dsh-huaweicloud-connect@0.7.13
```

装完**完全退出并重启** DeepSeek Harness 桌面版（Host 插件在启动时加载）。

### 备用：从 GitHub Release 安装

```sh
dsh plugin --profile desktop add github:Alanine-gH/dsh-huaweicloud-connect#v0.7.13
```

> **GitHub 需要能访问。** 如果你的机器连不上 github.com（常见于国内网络），
> 给 git 配一个代理即可，pnpm 解析 GitHub 源时会用上：
>
> ```sh
> git config --global http.proxy 127.0.0.1:<你的代理端口>
> ```

### 备用：仓库里的安装脚本

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

脚本做三件事：拷插件到 `<profile>/node_modules/`、从已有的 pi-ai 副本拷一份到插件自己的
`node_modules`（隔离，不动顶层包版本）、幂等更新 `package.json` 的 `dependencies` 与
`dsh.profile.bundles`。跑完会自检 BOM 并 fail fast。

### 版本兼容范围

声明了 `engines.dsh`：`>=0.2.1-rc.2 <0.3.0-0`，即 DSH **0.2.1 整个系列**（含 rc.2 / rc.3 及
后续 0.2.x）。0.2.0 及更早、0.3.0 及更晚都会被兼容门禁拒绝。

理由不是猜的：rc.2 → rc.3 里本插件用到的四个包（`dsh-llm`、`dsh-llm-pi-ai`、
`dsh-home-paths`、`dsh-client-ui-renderer`/`dsh-client-locale`）**逐个文件 SHA-256 相同**，
唯一差异是 `package.json` 里的版本号本身。早先版本把 peer 钉成精确 `0.2.1-rc.2`，
在 DSH 升到 rc.3 后就被判不兼容（`reasonIncompatibleVersion`）——那是一次误报。

---

## 使用

重启后，模型选择器会出现两个新分组：

- `OfficeAce` — 21 个模型
- `CodeArts` — 7 个模型（含实测验证过的 `deepseek-v4.1-flash`）

选一个模型直接对话即可。分组在没有可用登录态时会被隐藏（与 workbuddy 插件行为一致）。

### 诊断

```powershell
# 两个产品一起看
node "<profile>\node_modules\dsh-huaweicloud-connect\lib\bin.js" status

# 机器可读
node ... status --json

# 只看一个
node ... status --provider officeace
```

`status` 只发幂等 GET 拉模型目录，**不发对话请求、不刷新登录态**。

---

## 两个刻意为之的设计

### 1. 绝不刷新登录态

两个产品的 `refresh_token` 都是一次性轮换的：

- OfficeAce：插件若自行续期会与客户端抢，触发 `STS5.1806` **把用户登出**
- CodeArts：`refresh_token` 绑定 `client_id=codearts-agent` 且需要 DPoP 私钥（在客户端手里）

所以本插件只读凭据、只检查 `expiresAt`：

- OfficeAce：凭据不带过期时间，直接用
- CodeArts：STS 约 1 小时有效；过期时分组隐藏，并提示「打开 CodeArts Agent 让它自动续期」

### 2. 不给模型编造推理档位

上游没有稳定声明「哪些 `reasoning_effort` 真正生效」，而现有观测表明部分模型会**接受但忽略**
未知档位——一次 200 不能证明该档位可用。所以插件对全部模型都声明 `reasoning: false`，
不提供档位选择。这比给一个假的档位列表更诚实。

---

## 已知限制

- **CodeArts 的模型目录不能信接口返回**：这是实测踩到的坑。`/v1/model/builtin` 返回的 7 个模型
  **全部不能用于对话**（逐个发真实请求，一律返回 `InferHub.4005.200 unsupported model`）；
  IDE 下发的 `inferhub-provider` 只有 5 个，同样不含任何可用模型。真正可用的是客户端
  `model-cache-hook` 记录过的那批，其中 `deepseek-v4.1-flash` 已实测确认可用。
  本插件因此把 `/v1/model/builtin` 只当**探针**（验证凭据与签名是否正常），可选模型另用实测集。
- **CodeArts 有并发会话上限 3 个**：客户端开着时占满名额，插件发请求会得到
  `TM.00001041 并发会话数已达上限(3个)`。关掉客户端即可。
- **CodeArts 需要客户端在跑**：STS 由客户端每小时续期，插件不代劳。
- **OfficeAce 的 `models.json` 只在客户端跑过一次后落盘**：全新安装且从未登录时分组不显示。
- **上下文窗口是内置快照**：两个上游的模型列表接口都不返回 context window，用的是客户端内置元数据表
  （见 `lib/drivers/*.js` 里的 `CONTEXT_WINDOWS`）。上游上架新模型时会退回保守默认值。
- **模型目录是全量目录**：能列出来 ≠ 当前账号有权限。没有权限的模型会返回 `ModelArts.81004/81009`。
- **与 `deepseek-harness-codearts` 的关系**：npm 上存在一个独立插件 `deepseek-harness-codearts`，
  它自己完成 CodeArts 的 OAuth 登录（不读桌面凭据）。两者可以共存（provider id 不同：
  本插件是 `huaweicloud-codearts`，它是 `codearts`），但会看到两个 CodeArts 分组。

---

## 目录结构

```
lib/
├── index.js          Host 插件入口：provider 注册、catalog、轮询
├── client.js         Web 半边：设置界面（plugins.bundle.config slot）
├── web.js            同源只读 status / 写 visibility 路由
├── visibility.js     模型显隐存储（按账号分桶）
├── reasoning.js      推理档位探测 + 缓存
├── shim.js           回环 OpenAI 兼容 shim（四道闸 + 请求归一化 + SSE 兜底）
├── credentials.js    登录态复用：定位 → 分类 → 副本 → 刷新 → 降级
├── apig-sign.js      华为 APIG SDK-HMAC-SHA256 签名器（纯函数）
├── bin.js            诊断 CLI：status / doctor / logout
└── drivers/
    ├── officeace.js  Basic 头 + models.json 凭据
    └── codearts.js   AK/SK 签名 + state.vscdb 凭据

test/
├── selftest.mjs        离线自测（21 项：签名 / 归一化 / 凭据 / shim / 串行闸）
├── sign-selftest.mjs   签名专项（25 项）
├── web-selftest.mjs    status / visibility 路由（34 项）
├── client-selftest.mjs 客户端模块契约（33 项）
├── reasoning-selftest.mjs 推理档位探测（40 项）
├── live-probe.mjs      真实只读探测（只发 GET /models）
└── host/               测试台用的离线替身（dsh-llm / dsh-llm-pi-ai / schemastery）

scripts/install.ps1   绕开 pnpm 的安装脚本
```

自测（全部离线，不需要 DSH 也不需要网络）：

```powershell
npm test                              # 153/153（五套串跑）
node test\live-probe.mjs              # 会访问真实上游，只发 GET
```

---

## 环境变量

| 变量 | 作用 |
|---|---|
| `HUAWEI_OFFICEACE_AUTH_FILE` | 显式指定 OfficeAce 的 `models.json` 路径 |
| `HUAWEI_CODEARTS_AUTH_FILE` | 显式指定 CodeArts 的 `state.vscdb` 路径 |
| `HUAWEICLOUD_PI_AI_SOURCE` | 安装脚本用：指定含 `@earendil-works/pi-ai` 的 `node_modules` 目录 |

---

## 免责声明

- 本项目仅供个人学习与研究，只驱动使用者自己的账号在本机调用。
- 依赖两个客户端**未公开**的内部接口，客户端更新后可能需要调整。
- 使用需遵守华为云相应服务条款；因使用本项目产生的任何后果由使用者自行承担。
- 与华为云无关联，未获其授权或认可；文中名称仅用于描述兼容关系，商标权归各自所有。

## 许可证

MIT
