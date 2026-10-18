## 修复客户端「静默不执行」

前几版（v0.2.0 – v0.4.0）修的都是「崩溃」，这一版修的是「**什么都没发生**」。

### 症状

插件页显示「运行中」、bundle 已挂载，但设置卡片区域**完全空白**——没有卡片，也没有 loading 文案，控制台里也**没有任何报错**。

而 Host 侧一切正常：

```sh
curl http://127.0.0.1:19387/plugins/dsh-huaweicloud-connect/status
→ 200，21 个 OfficeAce 模型、7 个 CodeArts 模型
```

### 根因

逐字节对照 `dsh-workbuddy-connect` 的 bundle 后找到差异——**factory 的返回值形状**：

```js
// workbuddy（tsdown 产物）
var module = { exports: {} };
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
// … exports.apply = apply; …
return module.exports;

// 本插件（v0.4.0 及之前）
return { apply, inject, name, … };   // ← 普通对象字面量
```

`window.__ModuleLoader__` 按 ES Module 的约定取 factory 返回值。普通对象不被认，于是 **`apply()` 从头到尾没有被调用过**——注册不会发生，也不会抛错。

这解释了全部现象：空白、无报错、slot 树里查不到 key，而 Host 完全正常。

### 修法

照 workbuddy 的形状改：

```js
var module = { exports: {} };
const exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
// … 全部改成 exports.foo = foo …
return module.exports;
```

### 顺带修的两处

- **`VERSION` 改成从 `package.json` 读**（v0.4.0）。此前硬编码 `0.1.0`，而 status 文档一直报它，把排查方向带偏了两次。
- **正确处理 `view: 'page'`**。slot 契约（`Slots.listSubTree` 的 purpose 字段）明确写 `view: 'page'` only，此前只判了 `summary`。

### 验证

测试从 108 项增加到 **112 项**，新增 4 条：

- factory 返回值带 `Symbol.toStringTag === "Module"`
- `t` 为 null / undefined 时三种 view 都不崩
- `apply` 里不再出现 `ctx.locale.bind(`（只匹配代码、跳过注释）

```sh
npm test
# 20 + 25 + 34 + 32 = 111 passed
```

> 之前的 v0.4.0 修的 `t` 为 null 那个 bug 是**真的**（Console 里确有该报错），
> 但它只是第二层问题——即使修好，`apply()` 仍没被调用。

## 升级

```sh
dsh plugin --profile desktop remove dsh-huaweicloud-connect
dsh plugin --profile desktop add github:Alanine-gH/dsh-huaweicloud-connect#v0.5.0
```

装完**完全退出并重启**桌面版——客户端 bundle 只在启动时加载。