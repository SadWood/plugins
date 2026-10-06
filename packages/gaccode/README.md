# GACCode

在 [magpie](https://usemagpie.ai) / OpenCode 里用 [GACCode](https://gaccode.com) 的订阅额度。

**0.3.x**：额度卡片增加 USD / 加油包（只读）；时段倍率映射为 Magpie `rate`；常见 API 错误改写为中文。

## 做什么

- 登录：在 [API Keys](https://gaccode.com/api-keys) 拿到的 API key
- Claude：`https://gaccode.com/claudecode/v1`（Anthropic Messages）
- Codex：`https://gaccode.com/codex/v1`（OpenAI Responses）
- Gemini：`https://gaccode.com/gemini/v1beta`（`@ai-sdk/google`）
- 额度 / 用量：网站 JWT → `/api/credits/balance`、`/subscriptions`、`/credits/history`、`/usd-account`、`/credits/booster-packs`
- 登录时可选官方域名或 `relay05` 中继

若本机已有自定义供应商占用 `gaccode`，Magpie 会显示为 **`gaccode-plugin`**；provider id 仍是 `gaccode`。

## 额度卡片

Magpie 订阅卡只暴露 **一个**「积分」进度环（对齐 Codex：主余额 + 一个真实窗口）。账号名优先显示网站邮箱（JWT /me）。积分与每日重置写在「积分」进度条旁；Magpie「余额」行只在有 USD 或加油包时出现，避免与积分重复。

## 安装（magpie）

```bash
magpie plugin add @magpie-community/opencode-gaccode-auth

magpie plugin login gaccode
magpie provider test gaccode
magpie quota
```

模型名形如 `gaccode/claude-sonnet-4-5`、`gaccode/gpt-5.5`、`gaccode/gemini-3-flash`。

## OpenCode

```json
{ "plugin": ["@magpie-community/opencode-gaccode-auth"] }
```

然后 `opencode auth login`，选 GACCode。

## 登录与额度（quota）

推理用 API key；积分 / USD / 加油包面板要用网站登录态。`magpie plugin login gaccode` 时：

1. **推荐：GACCode API key** — 填 key，可选粘贴网站 JWT（浏览器登录 gaccode.com → DevTools → Application → Local Storage → `token`）
2. **API key + 网站登录** — 邮箱密码只用来换 JWT，**不保存密码**（依赖 magpie 把 API key 传给 `authorize`；若失败请用方式 1）

然后：`magpie quota`，或应用里该账号的额度卡片。会显示：

| 卡片 | 来源 |
|------|------|
| 积分 | `/api/credits/balance`（`balance` / `creditCap` / `refillRate` / `lastRefill`） |
| USD | `/api/usd-account` → `account.balanceUsd`；未开通账户或无字段时标明「无 USD …」，不报错 |
| 时段倍率 | 积分历史 `Time Multiplier(N - …)`；无记录时按工作日 9–12 / 14–18 估计 2x |
| 加油包 | `/api/credits/booster-packs` → `boosterPacks[]`（**只读**，不自动购买/使用） |
| 每日重置 | 工单「请求重置积分」；可选余额 ≤ 3 时自动申请 |

## 倍率 → Magpie `rate`

Magpie 模型字段 `rate` / `rateWas` 表示「一次请求消耗的点数倍率」。与 GACCode 时段倍率同义，因此：

- 当前倍率 `N`（如 2x）→ `rate: N`，且 `N > 1` 时 `rateWas: 1`
- 仅写入模型元数据供选择器展示，**不改变请求路由**

若你不希望模型列表带 rate，可忽略该字段；额度卡片里仍会单独显示「时段倍率」。

## Gemini 模型列表

- 基址：`{host}/gemini/v1beta`（与 `@ai-sdk/google` 一致）
- 列表尝试：`GET {host}/gemini/v1beta/models`（需 API key；无凭证时常 401）
- **失败或空列表时回退内置静态 Gemini 列表**（仍可发起对话）
- 未发现更稳的公开列表路径；若上游改路径可再改 `geminiBase` / `listGeminiModels` / `liveModels`

## 中文错误

`auth.loader` 的 `fetch` 对常见失败（额度不足、429、401、model_not_found、无渠道等）把英文/错误码改写成短中文，并附带原 message；**状态码原样保留**，401 仍带 `X-Magpie-Sign-In: expired`。

## 已知缺口

- 本账号探测时 `/api/usd-account` 返回 `account: null`（未开通 USD 账户）；有账户时应读 `balanceUsd`
- `/api/credits/booster-packs` 在无包时为 `boosterPacks: []`；有包时展示 `comment`/`credits`/`isUsed`/`expiresAt` 等（不调用 `…/use`）
- 尝试过的无效路径（多为前端 HTML）：`/api/boosters`、`/api/booster-packs`、`/api/products` 等

## License

MIT
