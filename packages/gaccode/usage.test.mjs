import { afterEach, beforeEach, expect, test } from "bun:test"
import { GacCodePlugin, _internal } from "./index.mjs"

const originalFetch = globalThis.fetch
const baseAuth = { type: "api", key: "fake-api-key", metadata: {} }
const withJwt = { ...baseAuth, metadata: { host: "https://relay05.gaccode.com", loginToken: "fake-site-jwt" } }
const statusPath = "/claudecode/v1/cc-status-line"
const sitePaths = ["/api/subscriptions", "/api/me", "/api/usd-account", "/api/credits/booster-packs", "/api/tickets?page=1&limit=20"]
let fixtureAccount = 0
beforeEach(() => { globalThis.fetch = async () => { throw new Error("unexpected network request") } })
afterEach(() => { globalThis.fetch = originalFetch })

function fakeUsage(replies = {}) {
  const seen = []
  // Distinct accounts prevent the old process-local refill cooldown hiding a write.
  const email = `fixture-${++fixtureAccount}@example.invalid`
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    seen.push(req)
    const defaults = {
      [statusPath]: { balance: 2, effectiveBalance: 2, creditCap: 100, refillRate: 5, timeMultiplier: { value: 1 } },
      // Legacy paths get data too, so the baseline exposes the actual unwanted write.
      "/api/credits/balance": { balance: 2, creditCap: 100, creditsPerHour: 5, lastRefill: "2020-01-01T00:00:00Z" },
      "/api/subscriptions": { subscriptions: [] },
      "/api/me": { email },
      "/api/usd-account": { account: null },
      "/api/credits/booster-packs": { boosterPacks: [] },
      "/api/tickets?page=1&limit=20": { tickets: [] },
      "/api/tickets/categories": { categories: [] },
      "/api/tickets": { ticket: { id: "fake-write" } },
      "/api/credits/history?limit=12": { history: [{ reason: "usage", createdAt: "2020-01-01T00:00:00Z", details: "Time Multiplier(7 - obsolete fixture)" }] },
    }
    const path = url.pathname + url.search
    const reply = Object.hasOwn(replies, path) ? replies[path] : defaults[path]
    if (reply instanceof Error) throw reply
    if (reply instanceof Response) return reply.clone()
    return Response.json(reply ?? {})
  }
  return seen
}

async function usage(auth = baseAuth) {
  return (await GacCodePlugin({})).auth.usage(async () => auth)
}

const textOf = (u) => [u.error, u.balance, ...(u.windows ?? []).map((w) => w.display)].filter(Boolean).join(" · ")

for (const host of [undefined, "https://relay05.gaccode.com"]) {
  test(`API-key-only usage GETs statusline on ${host ?? "default host"}`, async () => {
    const seen = fakeUsage()
    const result = await usage({ ...baseAuth, metadata: host ? { host } : {} })
    expect(seen.map((r) => r.url)).toEqual([`${host ?? "https://gaccode.com"}${statusPath}`])
    expect(seen[0].method).toBe("GET")
    expect(seen[0].headers.get("x-api-key")).toBe("fake-api-key")
    expect(result.signIn).toBe("kept")
    expect(textOf(result)).toContain("2")
    expect(textOf(result)).not.toMatch(/未配置网站 JWT|password/i)
  })
}

test("JWT extensions use only the main site's read-only allowlist, never the inference relay", async () => {
  const seen = fakeUsage()
  await usage(withJwt)
  expect(seen.every((r) => r.method === "GET")).toBe(true)
  const site = seen.filter((r) => new URL(r.url).pathname.startsWith("/api/"))
  expect(site.map((r) => { const u = new URL(r.url); return u.pathname + u.search }).sort()).toEqual([...sitePaths].sort())
  for (const req of site) {
    expect(new URL(req.url).origin).toBe("https://gaccode.com")
    expect(req.headers.get("authorization")).toBe("Bearer fake-site-jwt")
    expect(req.headers.has("x-api-key")).toBe(false)
  }
})

test("failed ticket lookup and low balance cannot create refill tickets, even on repeated reads", async () => {
  const seen = fakeUsage({ "/api/tickets?page=1&limit=20": Response.json({ error: "outage" }, { status: 503 }) })
  await usage(withJwt)
  await usage(withJwt)
  expect(seen.filter((r) => r.method !== "GET")).toEqual([])
})

for (const refused of ["status", "website"]) {
  test(`${refused} quota 401 keeps inference sign-in and an API-key request still succeeds`, async () => {
    fakeUsage(refused === "status"
      ? { [statusPath]: Response.json({ error: "quota status unavailable" }, { status: 401 }) }
      : Object.fromEntries([...sitePaths, "/api/credits/balance"].map((p) => [p, Response.json({ error: "expired site token" }, { status: 401 })])))
    const result = await usage(withJwt)
    expect(result.signIn).toBe("kept")
    // A readable source error may live beside the account balance or in error.
    expect(textOf(result)).toMatch(/失败|未获授权|过期|未知|error|unauthori[sz]ed|expired/i)
    globalThis.fetch = async () => Response.json({ id: "fake-inference-success" })
    const loaded = await (await GacCodePlugin({})).auth.loader(async () => withJwt)
    expect((await loaded.fetch("https://gaccode.com/codex/v1/responses", { method: "POST", body: "{}" })).status).toBe(200)
  })
}

test("continuous credit refill is an aside, not a fabricated reset window", async () => {
  fakeUsage()
  const result = await usage(withJwt)
  expect(result.windows.length).toBeGreaterThan(0)
  for (const window of result.windows) {
    expect(window.aside).toBe(true)
    expect(window.span).toBeUndefined()
    expect(window.resetsAt).toBeUndefined()
  }
})

for (const value of [0.8, 1, 5]) {
  test(`current multiplier ${value} comes from status.timeMultiplier.value, not old history`, async () => {
    fakeUsage({ [statusPath]: { balance: 20, creditCap: 100, timeMultiplier: { value } } })
    const result = await usage(withJwt)
    expect(textOf(result)).toMatch(new RegExp(`${String(value).replace(".", "\\.")}\\s*(?:x|×|倍)`, "i"))
    expect(textOf(result)).not.toMatch(/7\s*(?:x|×|倍)|obsolete fixture/)
  })
}

test("missing server multiplier is shown as unknown instead of a clock or history guess", async () => {
  fakeUsage({ [statusPath]: { balance: 20, creditCap: 100 } })
  const result = await usage(withJwt)
  expect(textOf(result)).toMatch(/倍率[^·；]*未知|multiplier[^·;]*unknown/i)
  expect(textOf(result)).not.toMatch(/7\s*(?:x|×|倍)|高峰时段/)
})

for (const [label, reply, pattern] of [
  ["no account", { account: null }, /无.*(?:USD|美元).*账户|(?:USD|美元)[^·；]*(?:无账户|未开通)|no.*(?:USD|dollar).*account/i],
  ["zero balance", { account: { balanceUsd: 0 } }, /\$0(?:\D|$)|USD\s*0/i],
  ["unknown fields", { account: { unfamiliarBalance: 123 } }, /(?:USD|美元)[^·；]*(?:未知|字段)|(?:unknown|field)[^·;]*USD/i],
  ["failed read", Response.json({ error: "fixture USD outage" }, { status: 503 }), /(?:USD|美元)[^·；]*(?:失败|错误|不可用)|(?:failed|error)[^·;]*USD/i],
]) {
  test(`USD ${label} remains visible and distinct`, async () => {
    fakeUsage({ "/api/usd-account": reply })
    expect(textOf(await usage(withJwt))).toMatch(pattern)
  })
}

test("expired unused booster is not displayed as available", () => {
  const line = _internal.formatBoosterLine({ id: 101, credits: 10, isUsed: false, expiresAt: "2020-01-01T00:00:00Z" })
  expect(line).toMatch(/过期|expired/i)
  expect(line).not.toMatch(/可用|available/i)
})

test("used booster is not displayed as available", () => {
  const line = _internal.formatBoosterLine({ id: 102, credits: 10, isUsed: true, expiresAt: "2099-01-01T00:00:00Z" })
  expect(line).toMatch(/已用|used/i)
  expect(line).not.toMatch(/可用|available/i)
})

test("a refill ticket proves an application, not that credits were replenished", async () => {
  fakeUsage({ "/api/tickets?page=1&limit=20": { tickets: [{ id: "fake-ticket", title: "请求重置积分", createdAt: new Date().toISOString(), status: "open" }] } })
  const result = await usage(withJwt)
  expect(textOf(result)).toMatch(/已申请|requested|applied/i)
  expect(textOf(result)).not.toMatch(/今日已重置|已到账|replenished|reset complete/i)
})

test("empty first page of tickets cannot prove there was never an application today", async () => {
  fakeUsage()
  // Old saved metadata may remain even after removal of the automatic-reset prompt.
  expect(textOf(await usage({ ...withJwt, metadata: { ...withJwt.metadata, autoDailyReset: "off" } })))
    .not.toMatch(/今日未申请|今日未重置|今天从未申请|never.*today/i)
})

for (const balance of [undefined, null, false, true, "", "   ", "not-a-balance", {}]) {
  test(`unknown status balance ${JSON.stringify(balance)} cannot become a zero balance`, async () => {
    fakeUsage({ [statusPath]: { balance, creditCap: 100, timeMultiplier: { value: 1 } } })
    const result = await usage()
    expect(result.signIn).toBe("kept")
    expect(result.windows).toEqual([])
    expect(textOf(result)).toMatch(/未知|未提供.*有效余额|unknown|unavailable/i)
    expect(textOf(result)).not.toMatch(/(?:^|\D)0\s*\/\s*100|\$0(?:\D|$)/)
  })
}

test("numeric zero status balance remains a real zero, separately from unknown", async () => {
  fakeUsage({ [statusPath]: { balance: 0, creditCap: 100, timeMultiplier: { value: 1 } } })
  const result = await usage()
  expect(textOf(result)).toMatch(/0\s*\/\s*100/)
  expect(result.windows[0]).toMatchObject({ used: 100, aside: true })
})

test("booster summary distinguishes expired, used and available credit without counting expired as usable", () => {
  const result = _internal.summarizeBoosters({ boosterPacks: [
    { id: 201, credits: 100, isUsed: false, expiresAt: "2020-01-01T00:00:00Z" },
    { id: 202, credits: 3, isUsed: false, expiresAt: "2099-01-01T00:00:00Z" },
    { id: 203, credits: 4, isUsed: true, expiresAt: "2099-01-01T00:00:00Z" },
  ] })
  expect(result.display).toMatch(/100\s*积分\s*·\s*已过期/)
  expect(result.display).toMatch(/3\s*积分\s*·\s*可用/)
  expect(result.display).not.toMatch(/100\s*积分\s*·\s*可用|可用[^；]*100/)
})

test("single-line balance places USD, booster state and application before website identity while keeping details", async () => {
  const email = "long-website-fixture@example.invalid"
  const plan = "Fixture Website Plan"
  const pack = { id: 301, comment: "fixture-booster-detail", credits: 9, isUsed: false, expiresAt: "2099-01-01T00:00:00Z" }
  fakeUsage({
    "/api/me": { email },
    "/api/subscriptions": { subscriptions: [{ planName: plan }] },
    "/api/usd-account": { account: { balanceUsd: 12.34 } },
    "/api/credits/booster-packs": { boosterPacks: [pack] },
    "/api/tickets?page=1&limit=20": { tickets: [{ title: "请求重置积分", createdAt: new Date().toISOString(), status: "CLOSED" }] },
  })
  const result = await usage(withJwt)
  const balance = result.balance
  const identity = balance.indexOf(email)
  expect(identity).toBeGreaterThanOrEqual(0)
  for (const marker of ["USD", "加油包", "今日已申请"]) {
    expect(balance.indexOf(marker)).toBeGreaterThanOrEqual(0)
    expect(balance.indexOf(marker)).toBeLessThan(identity)
  }
  expect(balance).toContain("$12.34")
  expect(balance).toMatch(/加油包[^；]*可用\s*1/)
  expect(balance).toMatch(/网站[^；]*归属未核验/)
  expect(balance.indexOf(plan)).toBeGreaterThan(identity)
  expect(balance).toContain("工单已关闭")
  expect(balance).toMatch(/今日已申请[^；]*到账未核验/)
  expect(balance).not.toMatch(/今日已重置|已到账/)
  const details = _internal.summarizeBoosters({ boosterPacks: [pack] }).display
  expect(details).toContain(pack.comment)
  expect(details).toContain("9 积分")
})

test("compact booster counts include every pack beyond the five detailed rows and separate all states", () => {
  const packs = [
    ...[401, 402, 403, 404, 405].map((id) => ({ id, credits: 3, isUsed: false, expiresAt: "2099-01-01T00:00:00Z" })),
    { id: 406, credits: 100, isUsed: false, expiresAt: "2020-01-01T00:00:00Z" },
    { id: 407, credits: 100, isUsed: true, expiresAt: "2020-01-01T00:00:00Z" },
    { id: 408, credits: 100, isUsed: false },
    { id: 409, credits: 100, isUsed: false, expiresAt: "not-a-date" },
  ]
  const summary = _internal.summarizeBoosters({ boosterPacks: packs })
  expect(summary.count).toBe(packs.length)
  expect(summary.compact).toMatch(/可用\s*5(?:\D|$)/)
  expect(summary.compact).toMatch(/已过期\s*1(?:\D|$)/)
  expect(summary.compact).toMatch(/已用\s*1(?:\D|$)/)
  expect(summary.compact).toMatch(/有效期未知\s*2(?:\D|$)/)
  expect(summary.display).toContain("补充包 #401")
  expect(summary.display).toContain("3 积分")
  expect(summary.compact).not.toContain(" · ")
  expect(summary.compact.startsWith("可用 ")).toBe(true)
})

for (const [status, label] of [
  ["WAITING_FOR_SUPPORT", "工单等待客服"], ["WAITING_FOR_USER", "工单等待用户回复"],
  ["CLOSED", "工单已关闭"], ["UNRECOGNIZED", "工单状态未知"],
]) {
  test(`official ticket state ${status} remains separate from credit arrival`, async () => {
    const email = "website@example.invalid"
    fakeUsage({ "/api/me": { email }, "/api/tickets?page=1&limit=20": {
      tickets: [{ category: { key: "REQUEST_TO_REFILL_CREDIT" }, createdAt: new Date().toISOString(), status }],
    } })
    const result = await usage(withJwt)
    expect(result.balance).toContain(label)
    expect(result.balance.indexOf(label)).toBeLessThan(result.balance.indexOf(email))
    expect(result.balance).toContain("到账未核验")
    expect(result.balance).not.toMatch(/已到账|今日已重置|审批通过|申请失败/)
  })
}

test("API-key account identity and refillRate use the verified statusline fields, independently of website identity", async () => {
  fakeUsage({ [statusPath]: { balance: 2, creditCap: 100, refillRate: 5,
    timeMultiplier: { value: 0.8 }, user: { id: 101, email: "key-owner@example.invalid" } },
    "/api/me": { email: "different-website@example.invalid" } })
  const result = await usage(withJwt)
  expect(result.user).toBe("key-owner@example.invalid")
  expect(result.balance).toContain("different-website@example.invalid")
  expect(result.balance).toContain("归属未核验")
  expect(result.windows[0].display).toContain("5/时")
  expect(result.signIn).toBe("kept")
})

test("website identity does not become API-key account identity when statusline fails", async () => {
  fakeUsage({ [statusPath]: Response.json({}, { status: 401 }), "/api/me": { email: "website@example.invalid" } })
  const result = await usage(withJwt)
  expect(result.user).toBeUndefined()
  expect(result.balance).toContain("website@example.invalid")
  expect(result.signIn).toBe("kept")
})
