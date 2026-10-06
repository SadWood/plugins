// GACCode (gaccode.com) as an OpenCode / magpie provider plugin.
//
// Login: API key from https://gaccode.com/api-keys
// Optional site JWT for quota (paste, or email/password → JWT; password not saved).
// Usage: credits, USD (usd-account), boosters (read-only), time multiplier, daily refill ticket.
// Claude → Anthropic Messages, Codex → OpenAI Responses, Gemini → Google.
//
// Magpie docs: https://usemagpie.ai/docs/zh/plugins
const PROVIDER = "gaccode"
const HOST_DEFAULT = "https://gaccode.com"
const ANTHROPIC = "@ai-sdk/anthropic"
const RESPONSES = "@ai-sdk/openai"
const GOOGLE = "@ai-sdk/google"
const FELL_BACK = Symbol.for("magpie.fellBack")

const CLAUDE_MODELS = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-fable-5", name: "Claude Fable 5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", context: 200_000, output: 64_000, reasoning: true, images: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: 200_000, output: 64_000, reasoning: false, images: true },
]

const CODEX_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-6-astra", name: "GPT-6 Astra", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-6-sol", name: "GPT-6 Sol", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-6-luna", name: "GPT-6 Luna", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", context: 400_000, output: 128_000, reasoning: true, images: true },
  { id: "gpt-5.5", name: "GPT-5.5", context: 400_000, output: 128_000, reasoning: true, images: true },
]

const GEMINI_MODELS = [
  { id: "gemini-3-pro-high", name: "Gemini 3 Pro High", context: 1_000_000, output: 65_536, reasoning: true, images: true },
  { id: "gemini-3-pro-low", name: "Gemini 3 Pro Low", context: 1_000_000, output: 65_536, reasoning: true, images: true },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", context: 1_000_000, output: 65_536, reasoning: true, images: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", context: 1_000_000, output: 65_536, reasoning: true, images: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", context: 1_000_000, output: 65_536, reasoning: true, images: true },
]

const known = Object.fromEntries(
  [...CLAUDE_MODELS, ...CODEX_MODELS, ...GEMINI_MODELS].map((m) => [m.id, m]),
)

function hostOf(auth) {
  const h = String(auth?.metadata?.host ?? HOST_DEFAULT).replace(/\/$/, "")
  return h || HOST_DEFAULT
}

function claudeBase(host) {
  return `${host}/claudecode/v1`
}

function codexBase(host) {
  return `${host}/codex/v1`
}

/** Magpie @ai-sdk/google appends `/models/:streamGenerateContent?alt=sse` */
function geminiBase(host) {
  return `${host}/gemini/v1beta`
}

function siteApi(host) {
  return `${host}/api`
}

function isClaude(id) {
  return /^claude-/i.test(id)
}

function isGemini(id) {
  return /^gemini-/i.test(id)
}

function prettyName(id) {
  const k = known[id]
  if (k) return k.name
  return id
    .replace(/^claude-/, "Claude ")
    .replace(/^gpt-/, "GPT-")
    .replace(/^gemini-/, "Gemini ")
    .replace(/-/g, " ")
    .replace(/\b(\d)\s+(\d)\b/g, "$1.$2")
}

function npmApiFor(id, host) {
  if (isClaude(id)) return { npm: ANTHROPIC, api: claudeBase(host) }
  if (isGemini(id)) return { npm: GOOGLE, api: geminiBase(host) }
  return { npm: RESPONSES, api: codexBase(host) }
}

/**
 * Magpie `rate` = 一次请求消耗的点数倍率（数字或 "x0.5"）。
 * GACCode 时段倍率语义一致：2x → rate 2 / rateWas 1。只作展示，不改路由。
 */
function multToRate(mult) {
  const value = Number(mult?.value)
  if (!Number.isFinite(value) || value <= 0) return {}
  if (value > 1) return { rate: value, rateWas: 1 }
  return { rate: 1 }
}

function configModel(m, host, rateInfo = {}) {
  const { npm, api } = npmApiFor(m.id, host)
  const variants = m.reasoning
    ? { low: {}, medium: {}, high: {}, ...(isClaude(m.id) || isGemini(m.id) ? {} : { xhigh: {} }) }
    : undefined
  return {
    name: m.name,
    provider: { npm, api },
    limit: { context: m.context, output: m.output },
    tool_call: true,
    ...(m.reasoning ? { reasoning: true, variants } : {}),
    ...(m.images
      ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } }
      : {}),
    ...rateInfo,
  }
}

function runtimeModel(m, host, providerID = PROVIDER, rateInfo = {}) {
  const { npm, api } = npmApiFor(m.id, host)
  const variants = Object.fromEntries(
    (m.efforts ?? (m.reasoning ? ["low", "medium", "high"] : [])).map((e) => [e, {}]),
  )
  return {
    id: m.id,
    providerID,
    name: m.name ?? prettyName(m.id),
    api: { id: m.id, url: m.api ?? api, npm: m.npm ?? npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 200_000, output: m.output ?? 64_000 },
    capabilities: {
      temperature: true,
      reasoning: !!m.reasoning || !!m.efforts?.length,
      attachment: !!m.images,
      toolcall: true,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants,
    ...rateInfo,
  }
}

function authHeaders(key) {
  return {
    authorization: `Bearer ${key}`,
    "x-api-key": key,
    "x-goog-api-key": key,
  }
}

async function listOpenAIModels(url, headers) {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...(headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const body = await res.json()
  const rows = Array.isArray(body?.data) ? body.data : []
  return rows.map((r) => r?.id).filter((id) => typeof id === "string" && id)
}

async function listGeminiModels(url, headers) {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...(headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const body = await res.json()
  if (Array.isArray(body?.data)) {
    return body.data.map((r) => r?.id).filter((id) => typeof id === "string" && id)
  }
  const rows = Array.isArray(body?.models) ? body.models : []
  return rows
    .map((r) => {
      const name = typeof r?.name === "string" ? r.name : typeof r?.id === "string" ? r.id : ""
      return name.replace(/^models\//, "")
    })
    .filter((id) => id && !id.includes("/"))
}

async function liveModels(host, apiKey) {
  const headers = apiKey ? authHeaders(apiKey) : undefined
  const [claudeIds, codexIds, geminiIds] = await Promise.all([
    listOpenAIModels(`${claudeBase(host)}/models`),
    listOpenAIModels(`${codexBase(host)}/models`),
    // Gemini：路径 {host}/gemini/v1beta/models；无 key / 非 JSON 时回退静态列表
    apiKey
      ? listGeminiModels(`${geminiBase(host)}/models`, headers).catch(() => [])
      : Promise.resolve([]),
  ])
  const out = []
  for (const id of claudeIds) {
    const k = known[id] ?? {
      id,
      name: prettyName(id),
      context: 200_000,
      output: 64_000,
      reasoning: true,
      images: true,
    }
    out.push({ ...k, id, npm: ANTHROPIC, api: claudeBase(host) })
  }
  for (const id of codexIds) {
    const k = known[id] ?? {
      id,
      name: prettyName(id),
      context: 400_000,
      output: 128_000,
      reasoning: true,
      images: true,
    }
    out.push({ ...k, id, npm: RESPONSES, api: codexBase(host) })
  }
  const geminiList = geminiIds.length ? geminiIds : GEMINI_MODELS.map((m) => m.id)
  for (const id of geminiList) {
    if (!isGemini(id)) continue
    const k = known[id] ?? {
      id,
      name: prettyName(id),
      context: 1_000_000,
      output: 65_536,
      reasoning: true,
      images: true,
    }
    out.push({ ...k, id, npm: GOOGLE, api: geminiBase(host) })
  }
  if (!out.length) throw new Error("GACCode returned an empty model list")
  return out
}

function loginTokenOf(auth) {
  const t = auth?.metadata?.loginToken || auth?.metadata?.token
  return typeof t === "string" && t.trim() ? t.trim() : ""
}

/** 从 JWT payload 取邮箱（不校验签名，只用于展示）。 */
function emailFromJwt(token) {
  if (!token || typeof token !== "string") return ""
  try {
    const part = token.split(".")[1]
    if (!part) return ""
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/")
    const pad = "=".repeat((4 - (b64.length % 4)) % 4)
    const json = Buffer.from(b64 + pad, "base64").toString("utf8")
    const payload = JSON.parse(json)
    const e = payload?.email || payload?.user_email || payload?.preferred_username
    return typeof e === "string" && e.includes("@") ? e.trim() : ""
  } catch {
    return ""
  }
}

function emailFromMe(me) {
  const e = me?.user?.email || me?.email || me?.data?.user?.email || me?.data?.email
  return typeof e === "string" && e.includes("@") ? e.trim() : ""
}

/** 展示用账号名：JWT → /me → metadata.email → 含 @ 的 accountId。 */
function accountEmail(auth, me) {
  return (
    emailFromJwt(loginTokenOf(auth)) ||
    emailFromMe(me) ||
    (typeof auth?.metadata?.email === "string" && auth.metadata.email.includes("@")
      ? auth.metadata.email.trim()
      : "") ||
    (typeof auth?.accountId === "string" && auth.accountId.includes("@") ? auth.accountId.trim() : "") ||
    ""
  )
}

async function siteFetch(host, path, token, { method = "GET", body } = {}) {
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "accept-language": "zh",
  }
  if (body !== undefined) headers["content-type"] = "application/json"
  const res = await fetch(`${siteApi(host)}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000),
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!res.ok) {
    const err = new Error(parsed?.error || parsed?.message || `GACCode ${path} → ${res.status}`)
    err.status = res.status
    throw err
  }
  return parsed
}

const REFILL_TITLES = new Set(["请求重置积分", "Request Credit Refill", "クレジット補充をお願いします"])
const AUTO_REFILL_BALANCE = 3
/** host|email → last auto-refill attempt ms (process-local cooldown) */
const refillCooldown = new Map()

function beijingNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }))
}

function beijingDateStr(d = beijingNow()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function isHighMultiplierHours(d = beijingNow()) {
  // 工作日 9–12、14–18（与 statusline 一致）
  if (d.getDay() === 0 || d.getDay() === 6) return false
  const h = d.getHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

function parseMultiplierFromDetails(details) {
  if (typeof details !== "string") return null
  const m = details.match(/Time Multiplier\((\d+)\s*-\s*([^)]+)\)/i)
  if (!m) return null
  const value = Number(m[1])
  return Number.isFinite(value) ? { value, label: m[2]?.trim() || "" } : null
}

function historyRows(hist) {
  if (Array.isArray(hist?.history)) return hist.history
  if (Array.isArray(hist?.data)) return hist.data
  if (Array.isArray(hist?.items)) return hist.items
  if (Array.isArray(hist)) return hist
  return []
}

function detectMultiplier(rows) {
  for (const record of rows) {
    const reason = record?.reason || record?.type || ""
    const details = record?.details || record?.description || ""
    if (reason && reason !== "usage" && !/usage/i.test(String(reason))) continue
    const parsed = parseMultiplierFromDetails(details)
    if (parsed) {
      return {
        value: parsed.value,
        active: parsed.value > 1,
        source: "history",
        label: parsed.label,
      }
    }
  }
  if (isHighMultiplierHours()) {
    return { value: 2, active: true, source: "time_fallback", label: "高峰时段" }
  }
  return { value: 1, active: false, source: "none", label: "" }
}

function isRefillTicket(ticket) {
  const title = String(ticket?.title || "")
  if (REFILL_TITLES.has(title)) return true
  if (/重置积分|Credit Refill|クレジット補充/i.test(title)) return true
  return false
}

function ticketOnBeijingDay(ticket, dayStr) {
  const raw = ticket?.createdAt || ticket?.created_at
  if (!raw) return false
  try {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return false
    const bj = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }))
    return beijingDateStr(bj) === dayStr
  } catch {
    return false
  }
}

async function resolveRefillCategoryId(host, token) {
  try {
    const body = await siteFetch(host, "/tickets/categories", token)
    const cats = body?.categories || body?.data || (Array.isArray(body) ? body : [])
    const hit = cats.find((c) => c?.key === "REQUEST_TO_REFILL_CREDIT")
    if (hit?.id != null) return hit.id
  } catch {
    // fall through
  }
  return 3
}

async function todayRefillStatus(host, token) {
  const day = beijingDateStr()
  try {
    const body = await siteFetch(host, "/tickets?page=1&limit=20", token)
    const tickets = body?.tickets || body?.data || []
    const today = tickets.filter((t) => isRefillTicket(t) && ticketOnBeijingDay(t, day))
    return { day, already: today.length > 0, ticket: today[0] || null }
  } catch (e) {
    return { day, already: false, ticket: null, error: e?.message || String(e) }
  }
}

async function requestDailyRefill(host, token) {
  const categoryId = await resolveRefillCategoryId(host, token)
  const body = await siteFetch(host, "/tickets", token, {
    method: "POST",
    body: {
      categoryId,
      title: "请求重置积分",
      description: "",
      language: "zh",
    },
  })
  return body
}

function autoRefillEnabled(auth) {
  const v = String(auth?.metadata?.autoDailyReset ?? "on").toLowerCase()
  return v !== "off" && v !== "false" && v !== "0"
}

async function siteLogin(host, email, password) {
  const res = await fetch(`${siteApi(host)}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `登录失败 ${res.status}`)
  if (body?.needsVerification) throw new Error("邮箱未验证，请先在网站完成验证")
  if (!body?.token) throw new Error("登录成功但未返回 token")
  return body.token
}

function nextRefillIso(lastRefill) {
  if (!lastRefill) return undefined
  try {
    const t = new Date(lastRefill)
    if (Number.isNaN(t.getTime())) return undefined
    return new Date(t.getTime() + 60 * 60 * 1000).toISOString()
  } catch {
    return undefined
  }
}

function formatHistoryLine(row) {
  const amount = row?.amount ?? row?.credits ?? row?.delta
  const desc = row?.description || row?.reason || row?.type || "用量"
  const when = row?.createdAt || row?.date || row?.time || ""
  const amt =
    typeof amount === "number" ? (amount > 0 ? `+${amount}` : String(amount)) : String(amount ?? "")
  const time = when ? ` ${String(when).replace("T", " ").slice(0, 16)}` : ""
  return `${desc} ${amt}${time}`.trim()
}

/** 从对象中按候选键名取第一个有限数字（不编造）。 */
function firstFiniteNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return null
  for (const k of keys) {
    if (obj[k] == null) continue
    const n = typeof obj[k] === "number" ? obj[k] : Number(obj[k])
    if (Number.isFinite(n)) return { key: k, value: n }
  }
  return null
}

const USD_KEYS = [
  "balanceUsd",
  "usdBalance",
  "usd",
  "dollar",
  "balanceDollar",
  "dollarBalance",
  "money",
  "moneyBalance",
]

/**
 * USD：优先 /api/usd-account → account.balanceUsd（网站前端同字段）。
 * 再扫 balance / me / subscriptions 上常见键；都没有则标明「无 USD 字段」。
 */
function extractUsd(usdBody, bal, me, sub) {
  const account = usdBody?.account ?? usdBody?.data?.account ?? null
  if (usdBody && account === null) {
    return { status: "no_account", display: "无 USD 账户（/api/usd-account.account=null）" }
  }
  if (account && typeof account === "object") {
    const hit = firstFiniteNumber(account, USD_KEYS)
    if (hit) {
      const enabled = account.enabled
      const en =
        enabled === false ? " · 已停用" : enabled === true ? "" : ""
      return {
        status: "ok",
        key: `account.${hit.key}`,
        value: hit.value,
        display: `$${hit.value}${en}`,
        enabled,
      }
    }
    return { status: "no_field", display: "无 USD 字段（account 无 balanceUsd 等）" }
  }

  for (const [label, obj] of [
    ["balance", bal],
    ["me", me?.user || me],
    ["subscriptions", sub?.subscriptions?.[0]?.subscription || sub?.subscriptions?.[0] || sub],
  ]) {
    const hit = firstFiniteNumber(obj, USD_KEYS)
    if (hit) {
      return {
        status: "ok",
        key: `${label}.${hit.key}`,
        value: hit.value,
        display: `$${hit.value}`,
      }
    }
  }
  return { status: "no_field", display: "无 USD 字段" }
}

function boosterRows(body) {
  if (Array.isArray(body?.boosterPacks)) return body.boosterPacks
  if (Array.isArray(body?.boosters)) return body.boosters
  if (Array.isArray(body?.data)) return body.data
  if (Array.isArray(body?.items)) return body.items
  if (Array.isArray(body)) return body
  return null
}

function formatBoosterLine(pack) {
  const name =
    pack?.name ||
    pack?.title ||
    pack?.comment ||
    (pack?.id != null ? `补充包 #${pack.id}` : "补充包")
  const credits = pack?.credits ?? pack?.amount ?? pack?.remaining ?? pack?.remainingCredits
  const cred =
    typeof credits === "number"
      ? `${credits} 积分`
      : credits != null
        ? String(credits)
        : ""
  let status = ""
  if (pack?.isUsed === true || pack?.used === true) status = "已用"
  else if (pack?.isUsed === false) status = "可用"
  else if (pack?.status) status = String(pack.status)
  const exp = pack?.expiresAt || pack?.expires_at || pack?.expiryDate
  const expStr = exp ? `到期 ${String(exp).replace("T", " ").slice(0, 16)}` : ""
  return [name, cred, status, expStr].filter(Boolean).join(" · ")
}

/**
 * Booster：只读 GET /api/credits/booster-packs（前端同路径；不调用 …/use）。
 * 字段：credits / comment / isUsed / expiresAt / usedAt 等。
 */
function summarizeBoosters(body, fetchError) {
  if (fetchError) {
    return { status: "error", display: `未找到 booster 接口或读取失败：${fetchError}` }
  }
  const rows = boosterRows(body)
  if (rows === null) {
    return { status: "missing", display: "未找到 booster 接口" }
  }
  if (!rows.length) {
    return { status: "empty", display: "" }
  }
  const active = rows.filter((p) => p?.isUsed !== true && p?.used !== true)
  const lines = (active.length ? active : rows).slice(0, 5).map(formatBoosterLine).filter(Boolean)
  const more = rows.length > 5 ? ` · 另有 ${rows.length - 5} 个` : ""
  return {
    status: "ok",
    count: rows.length,
    display: lines.join("；") + more,
  }
}

async function resolveMultiplierForAuth(auth) {
  const host = hostOf(auth)
  const token = loginTokenOf(auth)
  if (!token) return detectMultiplier([])
  try {
    const hist = await siteFetch(host, "/credits/history?limit=12", token)
    return detectMultiplier(historyRows(hist))
  } catch {
    return detectMultiplier([])
  }
}

async function buildUsage(auth) {
  const host = hostOf(auth)
  const token = loginTokenOf(auth)
  if (!token) {
    return {
      plan: "GACCode",
      user: accountEmail(auth, null) || "GACCode",
      windows: [],
      error: "未配置网站 JWT：重新登录时粘贴 localStorage.token，或选「邮箱密码换 JWT」",
      signIn: "kept",
    }
  }

  const [balanceSettled, subSettled, meSettled, histSettled, refillSettled, usdSettled, boosterSettled] =
    await Promise.allSettled([
      siteFetch(host, "/credits/balance", token),
      siteFetch(host, "/subscriptions", token),
      siteFetch(host, "/me", token),
      siteFetch(host, "/credits/history?limit=12", token),
      todayRefillStatus(host, token),
      siteFetch(host, "/usd-account", token),
      siteFetch(host, "/credits/booster-packs", token),
    ])

  if (balanceSettled.status === "rejected" && balanceSettled.reason?.status === 401) {
    return {
      error: "网站 JWT 已失效，请重新登录并更新额度凭证",
      windows: [],
      signIn: "expired",
    }
  }

  const out = { windows: [], signIn: "kept" }
  const bal = balanceSettled.status === "fulfilled" ? balanceSettled.value : null
  const sub = subSettled.status === "fulfilled" ? subSettled.value : null
  const me = meSettled.status === "fulfilled" ? meSettled.value : null
  const hist = histSettled.status === "fulfilled" ? histSettled.value : null
  const refill =
    refillSettled.status === "fulfilled"
      ? refillSettled.value
      : { day: beijingDateStr(), already: false, error: refillSettled.reason?.message }
  const usdBody = usdSettled.status === "fulfilled" ? usdSettled.value : null
  const boosterBody = boosterSettled.status === "fulfilled" ? boosterSettled.value : null
  const boosterErr =
    boosterSettled.status === "rejected" ? boosterSettled.reason?.message || String(boosterSettled.reason) : null

  const email = accountEmail(auth, me)
  out.user = email || "GACCode"

  if (sub?.subscriptions?.[0]) {
    const s0 = sub.subscriptions[0]
    const nested = s0.subscription || {}
    out.plan =
      s0.planName || s0.plan || nested.tier || nested.name || s0.name || s0.productName || "GACCode"
    if (s0.endDate) out.until = s0.endDate
    if (s0.autoRenew != null) out.renew = s0.autoRenew ? "auto" : "off"
  } else {
    out.plan = "GACCode"
  }

  const rows = historyRows(hist)
  const mult = detectMultiplier(rows)

  // 每日重置先算好，写进积分窗口 display；不占用 Magpie「余额」行
  // （有窗口时 Magpie 会固定标「余额」，字号大且与积分重复）。
  let refillNote = refill.already ? "今日已重置" : "今日未重置"
  if (refill.error) refillNote = "重置状态未知"
  if (
    autoRefillEnabled(auth) &&
    bal &&
    typeof bal.balance === "number" &&
    bal.balance <= AUTO_REFILL_BALANCE &&
    !refill.already
  ) {
    const coolKey = `${host}|${out.user}`
    const last = refillCooldown.get(coolKey) || 0
    if (Date.now() - last > 60_000) {
      refillCooldown.set(coolKey, Date.now())
      try {
        await requestDailyRefill(host, token)
        refill.already = true
        refillNote = "已自动申请重置"
      } catch {
        refillNote = "自动重置失败"
      }
    } else {
      refillNote = "自动重置冷却中"
    }
  } else if (!autoRefillEnabled(auth)) {
    refillNote += " · 自动重置已关"
  }

  const usd = extractUsd(usdBody, bal, me, sub)
  const boost = summarizeBoosters(boosterBody, boosterErr)

  if (bal && typeof bal.balance === "number") {
    const cap = typeof bal.creditCap === "number" ? bal.creditCap : 0
    const used = cap > 0 ? Math.max(0, Math.round(((cap - bal.balance) / cap) * 100)) : 0
    const rate = bal.creditsPerHour ?? bal.refillRate
    let display =
      rate != null ? `${bal.balance} / ${cap || "?"} · ${rate}/时` : `${bal.balance} / ${cap || "?"}`
    if (mult.active) {
      display += ` · 倍率 ${mult.value}x`
      if (mult.label) display += `（${mult.label}）`
    }
    display += ` · ${refillNote}`
    out.windows.push({
      name: "积分",
      used,
      resetsAt: nextRefillIso(bal.lastRefill),
      span: 3600,
      display,
    })
  } else if (balanceSettled.status === "rejected") {
    out.error = balanceSettled.reason?.message || "读取积分失败"
  }

  // Magpie「余额」= 周期窗口以外的钱。有积分窗口时默认不写；
  // 仅 USD / 加油包有内容时才占用余额行。
  const extras = []
  if (usd.status === "ok") extras.push(`USD ${usd.display}`)
  if (boost.status === "ok") extras.push(`加油包 ${boost.display}`)
  if (extras.length) out.balance = extras.join(" · ")
  else if (!out.windows.length && bal && typeof bal.balance === "number") {
    const cap = typeof bal.creditCap === "number" ? bal.creditCap : 0
    out.balance = cap > 0 ? `${bal.balance} / ${cap} 积分` : `${bal.balance} 积分`
  }

  return out
}

/** 把厂商英文/错误码改成短中文，保留原 message；不改状态码。 */
function localizeProviderError(status, text) {
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }

  const pick =
    (typeof parsed?.error === "string" && parsed.error) ||
    (typeof parsed?.error?.message === "string" && parsed.error.message) ||
    (typeof parsed?.message === "string" && parsed.message) ||
    (typeof parsed?.error?.type === "string" && parsed.error.type) ||
    text ||
    ""
  const raw = String(pick).trim()
  const lower = raw.toLowerCase()

  let zh = null
  if (
    status === 401 ||
    /unauthorized|invalid[_\s-]*(api[_\s-]?key|token|auth)|authentication failed|not authenticated/i.test(
      raw,
    )
  ) {
    zh = "认证失败"
  } else if (status === 429 || /rate[_\s-]?limit|too many requests|throttl|exceeded.*quota.*rate/i.test(raw)) {
    zh = "请求过于频繁（限流）"
  } else if (
    /insufficient[_\s-]?(credits?|quota|balance)|credits?[_\s-]?insufficient|quota[_\s-]?exceeded|out of credits|余额不足|额度不足|积分不足/i.test(
      raw,
    ) ||
    ((status === 402 || status === 403) && /credit|quota|balance|额度|积分/i.test(raw))
  ) {
    zh = "额度不足"
  } else if (/model[_\s-]?not[_\s-]?found|unknown model|invalid model|no such model/i.test(raw)) {
    zh = "模型不存在"
  } else if (
    /no[_\s-]*(available[_\s-]*)?channel|channel[_\s-]*(unavailable|not found)|无渠道|无可用渠道|no[_\s-]*route/i.test(
      raw,
    )
  ) {
    zh = "无可用渠道"
  }

  if (!zh) return null

  const combined = raw && raw !== zh ? `${zh}（${raw.slice(0, 180)}）` : zh

  if (parsed && typeof parsed === "object") {
    const next = { ...parsed }
    if (typeof next.error === "string") next.error = combined
    else if (next.error && typeof next.error === "object") {
      next.error = { ...next.error, message: combined }
    } else if (typeof next.message === "string") next.message = combined
    else next.message = combined
    return JSON.stringify(next)
  }

  if (!text || !text.trim()) {
    return JSON.stringify({ error: combined })
  }
  return combined
}

async function wrapProviderFetch(input, init, key) {
  const headers = new Headers(
    init.headers ?? (input instanceof Request ? input.headers : undefined),
  )
  headers.set("authorization", `Bearer ${key}`)
  headers.set("x-api-key", key)
  headers.set("x-goog-api-key", key)
  const res = await fetch(input, { ...init, headers })

  if (res.status === 401) {
    const headersOut = new Headers(res.headers)
    headersOut.set("X-Magpie-Sign-In", "expired")
    headersOut.delete("content-length")
    headersOut.delete("content-encoding")
    const text = await res.text()
    const localized = localizeProviderError(res.status, text) ?? text
    return new Response(localized, {
      status: res.status,
      statusText: res.statusText,
      headers: headersOut,
    })
  }

  if (res.status < 400) return res

  const ct = res.headers.get("content-type") || ""
  // 只改写 JSON / 文本错误体，避免动 SSE 成功流
  if (!/json|text|empty|^$/.test(ct) && ct && !ct.includes("json") && !ct.includes("text")) {
    return res
  }

  const text = await res.text()
  const localized = localizeProviderError(res.status, text)
  if (!localized) {
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }

  const headersOut = new Headers(res.headers)
  headersOut.delete("content-length")
  headersOut.delete("content-encoding")
  if (!headersOut.get("content-type")) headersOut.set("content-type", "application/json")
  return new Response(localized, {
    status: res.status,
    statusText: res.statusText,
    headers: headersOut,
  })
}

const hostPrompt = {
  type: "select",
  key: "host",
  message: "GACCode 接入点",
  options: [
    { label: "官方 (gaccode.com)", value: HOST_DEFAULT },
    { label: "中继 relay05", value: "https://relay05.gaccode.com", hint: "部分教程里的备用线" },
  ],
}

function pickKey(inputs) {
  for (const k of ["key", "apiKey", "api_key", "apikey", "value"]) {
    if (typeof inputs?.[k] === "string" && inputs[k].trim()) return inputs[k].trim()
  }
  return ""
}

export const _internal = {
  PROVIDER,
  HOST_DEFAULT,
  CLAUDE_MODELS,
  CODEX_MODELS,
  GEMINI_MODELS,
  claudeBase,
  codexBase,
  geminiBase,
  liveModels,
  prettyName,
  buildUsage,
  siteLogin,
  listGeminiModels,
  detectMultiplier,
  parseMultiplierFromDetails,
  todayRefillStatus,
  requestDailyRefill,
  isHighMultiplierHours,
  extractUsd,
  summarizeBoosters,
  formatBoosterLine,
  multToRate,
  localizeProviderError,
}

export async function GacCodePlugin() {
  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      const host = HOST_DEFAULT
      // config 阶段无账号 JWT：按时段估计倍率写入 rate（仅展示）
      const rateInfo = multToRate(detectMultiplier([]))
      cfg.provider[PROVIDER] = {
        name: "GACCode",
        npm: ANTHROPIC,
        api: claudeBase(host),
        ...was,
        models: {
          ...Object.fromEntries(CLAUDE_MODELS.map((m) => [m.id, configModel(m, host, rateInfo)])),
          ...Object.fromEntries(CODEX_MODELS.map((m) => [m.id, configModel(m, host, rateInfo)])),
          ...Object.fromEntries(GEMINI_MODELS.map((m) => [m.id, configModel(m, host, rateInfo)])),
          ...(was.models ?? {}),
        },
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        // 无 authorize：key 原样保存，prompts → metadata（最稳）
        {
          type: "api",
          label: "GACCode API key",
          placeholder: "从 gaccode.com/api-keys 复制",
          prompts: [
            hostPrompt,
            {
              type: "text",
              key: "loginToken",
              message: "网站 JWT（可选，查额度）",
              placeholder: "留空不查；浏览器登录后 localStorage.token",
            },
            {
              type: "select",
              key: "autoDailyReset",
              message: "余额过低时自动申请每日积分重置",
              options: [
                { label: "开（余额≤3 且今日未申请）", value: "on" },
                { label: "关（只显示状态）", value: "off" },
              ],
            },
          ],
          async authorize(inputs = {}) {
            const key = pickKey(inputs)
            if (!key) {
              return { type: "failed", error: "未拿到 API key" }
            }
            const host = String(inputs.host || HOST_DEFAULT).replace(/\/$/, "") || HOST_DEFAULT
            const loginToken = String(inputs.loginToken || "").trim()
            const email = emailFromJwt(loginToken)
            return {
              type: "success",
              key,
              ...(email ? { accountId: email } : {}),
              metadata: {
                host,
                ...(loginToken ? { loginToken } : {}),
                ...(email ? { email } : {}),
                autoDailyReset: inputs.autoDailyReset || "on",
              },
            }
          },
        },
        // 邮箱密码只换 JWT，不落盘密码；需 Magpie 把 API key 放进 inputs
        {
          type: "api",
          label: "API key + 网站登录（查额度）",
          placeholder: "从 gaccode.com/api-keys 复制",
          prompts: [
            hostPrompt,
            { type: "text", key: "email", message: "网站邮箱" },
            { type: "text", key: "password", message: "网站密码（只用于换 JWT，不保存）" },
            {
              type: "select",
              key: "autoDailyReset",
              message: "余额过低时自动申请每日积分重置",
              options: [
                { label: "开（余额≤3 且今日未申请）", value: "on" },
                { label: "关（只显示状态）", value: "off" },
              ],
            },
          ],
          async authorize(inputs = {}) {
            const key = pickKey(inputs)
            if (!key) {
              return {
                type: "failed",
                error: "未拿到 API key。请改用「GACCode API key」并粘贴 JWT，或升级 magpie 后再试本方式",
              }
            }
            const host = String(inputs.host || HOST_DEFAULT).replace(/\/$/, "") || HOST_DEFAULT
            const email = String(inputs.email || "").trim()
            const password = String(inputs.password || "")
            if (!email || !password) {
              return { type: "failed", error: "请填写网站邮箱和密码" }
            }
            try {
              const loginToken = await siteLogin(host, email, password)
              return {
                type: "success",
                key,
                accountId: email,
                metadata: {
                  host,
                  loginToken,
                  email,
                  autoDailyReset: inputs.autoDailyReset || "on",
                },
              }
            } catch (e) {
              return { type: "failed", error: e?.message || String(e) }
            }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const key = auth.key
        return {
          apiKey: key,
          headers: authHeaders(key),
          async fetch(input, init = {}) {
            return wrapProviderFetch(input, init, key)
          },
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) {
          return { error: "未登录", windows: [], signIn: "kept" }
        }
        try {
          return await buildUsage(auth)
        } catch (e) {
          return { error: e?.message || String(e), windows: [], signIn: "kept" }
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api") return provider.models
        const host = hostOf(auth)
        const mult = await resolveMultiplierForAuth(auth)
        const rateInfo = multToRate(mult)
        try {
          const list = await liveModels(host, auth.key)
          return Object.fromEntries(list.map((m) => [m.id, runtimeModel(m, host, PROVIDER, rateInfo)]))
        } catch {
          const fallback = { ...provider.models }
          for (const id of Object.keys(fallback)) {
            if (fallback[id] && typeof fallback[id] === "object") {
              fallback[id] = { ...fallback[id], ...rateInfo }
            }
          }
          fallback[FELL_BACK] = true
          return fallback
        }
      },
    },
  }
}

export default {
  id: "gaccode-auth",
  server: GacCodePlugin,
}
