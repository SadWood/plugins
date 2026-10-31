// Use the native runner in each environment; no test or assertion shims.
const { test, afterEach } = await import(globalThis.Bun ? "bun:test" : "node:test");
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onRequest, onResponse, reset } from "./nowledge-mem.hooks.mjs";
import { resolveOptions } from "./mem.mjs";
import { captureMessage } from "./capture-filter.mjs";
import { cindyUserText } from "./cindy-capture.mjs";
import { open, close, notice } from "./conversation.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/cindy-capture.json", import.meta.url), "utf8"));
const originalFetch = globalThis.fetch;
let unexpectedRequests = [];
afterEach(() => {
    globalThis.fetch = originalFetch;
    reset();
    const unexpected = unexpectedRequests;
    unexpectedRequests = [];
    assert.deepEqual(unexpected, [], "unexpected transport calls must not be hidden by fail-open capture");
});
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const reply = (content = "Done") => ({ choices: [{ finish_reason: "stop", message: assistant(content) }] });
const roles = (payload) => payload.messages.map(({ role, content }) => ({ role, content }));
const human = { captureFilter: "human" };
const cindy = { captureFilter: "human", captureCindyAgents: ["pi"] };
const context = (options = {}, overrides = {}) => ({ protocol: "chat", origin: "local", agent: "pi", session: "MiXeD-Session",
    query: "Synthetic question", cwd: "/fixture/project", options: { recall: false, capture: true, ...options },
    state: {}, signal: new AbortController().signal, ...overrides });
function receiver(ack = { success: true, failed_count: 0, results: [{ success: true }] }, status = 200) {
    const writes = [];
    globalThis.fetch = async (url, init) => {
        if (new URL(url).pathname !== "/threads/import")
            unexpectedRequests.push(new URL(url).pathname);
        assert.equal(new URL(url).pathname, "/threads/import");
        writes.push(JSON.parse(init.body));
        return Response.json(ack, { status });
    };
    return writes;
}
async function run(body, ctx, response = reply(), success = true) {
    const before = structuredClone(body);
    const beforeReply = structuredClone(response);
    await onRequest(body, ctx);
    assert.deepEqual(body, before, "capture must not edit model input");
    ctx.request = body;
    ctx.success = success;
    await onResponse(response, ctx);
    assert.deepEqual(body, before, "capture must not edit the accepted request");
    assert.deepEqual(response, beforeReply, "capture must not edit client output");
}
async function capture(messages, options = {}, overrides = {}, response = reply()) {
    const writes = receiver();
    const body = { model: "fixture", stream: false, messages };
    const ctx = context(options, overrides);
    await run(body, ctx, response);
    return { writes, ctx, body };
}
const tools = [user("Synthetic question"), { ...assistant("I will check the change"), tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "tool output" }];

test("off is byte-compatible with legacy capture including tools", async () => {
    const a = await capture(tools);
    reset();
    const b = await capture(tools, { captureFilter: "off", captureCindyAgents: ["pi"] });
    assert.deepEqual(b.writes, a.writes);
});
test("off keeps the legacy captureTools=false projection", async () => {
    const { writes } = await capture(tools, { captureFilter: "off", captureTools: false });
    assert.deepEqual(roles(writes[0]), [user("Synthetic question"), assistant("Done")]);
});
test("human drops tool activity but retains adjacent assistant commentary", async () => {
    const { writes } = await capture(tools, { ...human, captureTools: false });
    assert.deepEqual(roles(writes[0]), [user("Synthetic question"), assistant("I will check the change"), assistant("Done")]);
});
test("human takes precedence over captureTools=true", async () => {
    const { writes } = await capture(tools, { ...human, captureTools: true });
    assert.deepEqual(roles(writes[0]), [user("Synthetic question"), assistant("I will check the change"), assistant("Done")]);
});
test("Cindy cleaning is opt-in and capture-only, with a clean title", async () => {
    const { writes } = await capture([user(fixture.language + "\n    important code")], cindy);
    assert.equal(writes[0].messages[0].content, "    important code");
    assert.equal(writes[0].title, "important code");
});
test("new option values are validated rather than silently enabled", () => {
    assert.equal(resolveOptions({}, {}).captureFilter, "off");
    assert.deepEqual(resolveOptions({}, {}).captureCindyAgents, []);
    for (const captureFilter of [true, null, "all", "HUMAN", {}, 0])
        assert.throws(() => resolveOptions({ captureFilter }, {}), /invalid/);
    for (const captureCindyAgents of [true, null, "pi", {}, [null], ["*"], [""], ["pi "], ["a".repeat(65)], Array(21).fill("pi")])
        assert.throws(() => resolveOptions({ captureCindyAgents }, {}), /invalid/);
    const ids = ["pi", "pi", "cindy"];
    const options = resolveOptions({ captureCindyAgents: ids }, {});
    ids.push("omp");
    assert.deepEqual(options.captureCindyAgents, ["pi", "cindy"]);
});

// Four protocol contracts: synthetic wire adaptations, not native session files.
const protocols = [
    {
        protocol: "chat", body: { messages: tools }, response: reply(),
    },
    {
        protocol: "responses", body: { input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic question" }] },
            { type: "reasoning", summary: [{ type: "summary_text", text: "internal thought" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will check the change" }] },
            { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
            { type: "function_call_output", call_id: "c1", output: "tool output" },
        ] }, response: { status: "completed", output: [{ type: "message", ...assistant("Done") }] },
    },
    {
        protocol: "anthropic", body: { messages: [user("Synthetic question"), assistant([
            { type: "thinking", thinking: "internal thought" },
            { type: "text", text: "I will check the change" },
            { type: "tool_use", id: "c1", name: "read", input: {} },
        ]), user([{ type: "tool_result", tool_use_id: "c1", content: "tool output" }])] },
        response: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] },
    },
    {
        protocol: "gemini", body: { contents: [
            { role: "user", parts: [{ text: "Synthetic question" }] },
            { role: "model", parts: [{ thought: true, text: "internal thought" }, { text: "I will check the change" }, { functionCall: { id: "c1", name: "read", args: {} } }] },
            { role: "user", parts: [{ functionResponse: { id: "c1", name: "read", response: { output: "tool output" } } }] },
        ] }, response: { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Done" }] } }] },
    },
];
for (const { protocol, body, response } of protocols) {
    test(`${protocol}: human dialogue preserves commentary and final output`, async () => {
        const writes = receiver();
        await run(structuredClone(body), context(human, { protocol }), response);
        assert.equal(writes.length, 1);
        assert.deepEqual(roles(writes[0]), [user("Synthetic question"), assistant("I will check the change"), assistant("Done")]);
        assert.equal(writes[0].metadata.protocol, protocol);
    });
}
test("Responses string input and legacy Chat function calls are supported", async () => {
    let writes = receiver();
    await run({ input: "Synthetic question" }, context(human, { protocol: "responses" }), protocols[1].response);
    assert.deepEqual(roles(writes[0]), [user("Synthetic question"), assistant("Done")]);
    reset();
    const a = await capture([user("Synthetic question"), { ...assistant("Commentary"), function_call: { name: "read", arguments: "{}" } }, { role: "function", name: "read", content: "output" }], human);
    assert.deepEqual(roles(a.writes[0]), [user("Synthetic question"), assistant("Commentary"), assistant("Done")]);
});
test("human does not make a pending tool loop or truncated response capturable", async () => {
    for (const response of [replyWithFinish("tool_calls"), replyWithFinish("length"), { choices: [{ finish_reason: "stop", message: tools[1] }] }]) {
        reset();
        assert.equal((await capture([user("Synthetic question")], human, {}, response)).writes.length, 0);
    }
    assert.equal((await capture(tools.slice(0, 2), human)).writes.length, 0, "missing tool output must still block capture");
    assert.equal((await capture([tools[0], tools[2]], human)).writes.length, 0, "orphan output must still block capture");
});
function replyWithFinish(finish_reason) { return { choices: [{ finish_reason, message: assistant("Partial") }] }; }
test("only text captions are retained; reasoning, images and unknown blocks create no placeholders", async () => {
    const { writes } = await capture([user([
        { type: "text", text: "Look at these" },
        { type: "image_url", image_url: { url: "data:image/png;base64,SYNTHETIC" } },
        { type: "file", file: { filename: "fixture.pdf", file_data: "SYNTHETIC" } },
        { type: "unknown", text: "unknown internal data" },
    ]), assistant([{ type: "thinking", text: "internal" }, { type: "text", text: "I reviewed the attachments" }])], human);
    assert.deepEqual(roles(writes[0]), [user("Look at these"), assistant("I reviewed the attachments"), assistant("Done")]);
});
test("human preserves complete long Unicode dialogue and indentation (PR #782/#785)", async () => {
    const long = "    " + "测试🙂".repeat(7000) + "\n    final line\n";
    const { writes } = await capture([user(long)], human, {}, reply(long));
    assert.equal(writes[0].messages[0].content, long);
    assert.equal(writes[0].messages[1].content, long);
});
test("literal skill commands survive; gateway does not fabricate missing native drafts", async () => {
    const { writes } = await capture([user("/skill:review fixture"), assistant("Skill response"), user("Expanded skill text without native attribution")], human);
    assert.deepEqual(roles(writes[0]), [user("/skill:review fixture"), assistant("Skill response"), user("Expanded skill text without native attribution"), assistant("Done")]);
});

for (const name of ["side", "channel", "client", "language", "writable", "referenceDirectories", "handoff", "rebuild", "fork"]) {
    test(`Cindy complete ${name} prefix is removed without trimming body`, () => {
        const body = "    const keep = true;\n\n";
        assert.equal(cindyUserText(fixture[name] + "\n" + body).content, body);
    });
}
test("Cindy stacked side/fork/language/grant templates and CRLF are recognized", () => {
    const raw = [fixture.side, fixture.fork, fixture.language, fixture.writable, fixture.client, "    body"].join("\n\n").replaceAll("\n", "\r\n");
    assert.equal(cindyUserText(raw).content, "    body");
});
test("Cindy current and legacy mobile templates require the complete known suffix", () => {
    const mobile = fixture.client.replace("另一台电脑", "手机") + fixture.mobilePreference;
    const legacy = "[客户端说明] 以下为系统每轮自动追加的环境说明,不是用户发来的消息;回复时不要把它当作用户的请求,也不要引用、复述或据此臆测用户意图。本轮请求来自手机客户端(小屏、远程查看被控电脑上的文件)。" + fixture.mobilePreference;
    for (const note of [mobile, legacy])
        assert.equal(cindyUserText(note + "\nbody").content, "body");
    const unknown = mobile + "unknown instruction\nbody";
    assert.equal(cindyUserText(unknown).content, unknown);
});
test("Cindy is inert unless both human and the exact agent ID opt in", async () => {
    const raw = fixture.language + "\nbody";
    for (const [options, agent] of [[human, "pi"], [cindy, "omp"], [cindy, "PI"], [cindy, undefined], [{ captureFilter: "off", captureCindyAgents: ["pi"] }, "pi"]]) {
        reset();
        const { writes } = await capture([user(raw)], options, { agent });
        assert.equal(writes[0].messages[0].content, raw);
    }
});
test("Cindy quoted, fenced, indented, embedded, unknown and incomplete examples are preserved", () => {
    for (const raw of [
        "> " + fixture.language, "```text\n" + fixture.language + "\n```", "    " + fixture.language,
        "Explain this:\n" + fixture.language, fixture.language.slice(0, -1), fixture.language + "suffix",
        fixture.side.slice(0, -1), fixture.side + "not a delimiter", "[Unknown note]\n" + fixture.language,
        "<cindy-extra-writable-directories>\nunfinished", "<cindy-extra-writable-directories>\nx\n</cindy-extra-writable-directories>body",
        "[Session handoff · internal context]\nunfinished\nbody",
        "[Session fork · internal context]\nx\n== fork说明结束,以下是用户的新消息 ==\nbody",
    ]) assert.equal(cindyUserText(raw).content, raw);
});
test("handoff terminators inside Markdown fences do not close the note", () => {
    const heading = "[Session handoff · internal context]";
    const end = "== End of handoff note; the user's new message follows ==";
    for (const fence of ["```", "~~~~"]) {
        const raw = `${heading}\n${fence}\n${end}\n${fence}\n${end}\n    body`;
        assert.equal(cindyUserText(raw).content, "    body");
        const incomplete = `${heading}\n${fence}\n${end}`;
        assert.equal(cindyUserText(incomplete).content, incomplete);
    }
});
test("assistant text is never cleaned or recast as user evidence (#711)", async () => {
    const quote = fixture.language + "\nA suggestion, not an adopted preference";
    const { writes } = await capture([user("Explain this"), assistant(quote)], cindy);
    assert.deepEqual(roles(writes[0]), [user("Explain this"), assistant(quote), assistant("Done")]);
});
test("Cindy group provenance retains speaker names but not header transport IDs (#711)", async () => {
    const { writes } = await capture([user(fixture.group + "\n" + fixture.client + "\nKeep this")], cindy);
    const message = writes[0].messages[0];
    assert.equal(message.content, "发言人「Fixture Guest」：\nKeep this");
    assert.deepEqual(message.metadata.cindy_origin, { channel: "wechat", chat_kind: "group", chat_name: "Fixture Group", sender_name: "Fixture Guest", sender_is_owner: false });
    assert.equal(JSON.stringify(writes).includes("synthetic-group"), false);
    assert.equal(JSON.stringify(writes).includes("synthetic-sender"), false);
    assert.equal(JSON.stringify(writes).includes("synthetic-host"), false);
});
test("private non-owner and unnamed group speakers remain distinguishable", () => {
    const nonOwner = fixture.group.replace("微信群", "微信私聊");
    assert.match(cindyUserText(nonOwner + "\nbody").content, /^发言人「Fixture Guest」/u);
    const unnamed = "[渠道说明] 系统追加，不是用户消息。本条来自微信群 (chat_id: synthetic)，发言人不是主人。";
    assert.equal(cindyUserText(unnamed + "\nbody").content, "发言人（非主人）：\nbody");
    const owner = fixture.group.replace("微信群", "微信私聊").replace("不是主人", "是主人");
    const p = cindyUserText(owner + "\nbody");
    assert.equal(p.content, "body");
    assert.equal(p.cindyOrigin.sender_is_owner, true);
});
test("header cleanup never scrubs identifiers from real user body", () => {
    const body = "Keep this diagnostic: device_id: fixture-value";
    assert.equal(cindyUserText(fixture.client + "\n" + body).content, body);
});
test("no human user text left means no Thread write", async () => {
    const { writes } = await capture([user(fixture.language)], cindy);
    assert.equal(writes.length, 0);
});
test("Side Chat notes do not authorize removing inherited messages or rebinding Threads", async () => {
    const messages = [user("Parent question"), assistant("Parent answer"), user(fixture.side + "\n" + fixture.fork + "\nChild question")];
    const { writes } = await capture(messages, cindy, { session: "Child-Session" });
    assert.deepEqual(roles(writes[0]), [user("Parent question"), assistant("Parent answer"), user("Child question"), assistant("Done")]);
    assert.equal(writes[0].metadata.pi_parent_session_id, undefined);
    assert.match(writes[0].thread_id, /^magpie-Child-Session-/u);
});
test("bounded prefix stacks cannot be partly cleaned by repeated passes (#756)", () => {
    const max = (fixture.language + "\n").repeat(64) + "body";
    const over = (fixture.language + "\n").repeat(65) + "body";
    assert.equal(cindyUserText(max).content, "body");
    assert.equal(cindyUserText(over).content, over);
    assert.equal(cindyUserText(cindyUserText(over).content).content, over);
});

test("filter modes retain original Thread and message IDs, including mixed-case sessions (#621)", async () => {
    const raw = [user(fixture.language + "\nSynthetic question"), ...tools.slice(1)];
    const off = (await capture(raw)).writes[0];
    reset();
    const filtered = (await capture(raw, cindy)).writes[0];
    assert.equal(filtered.thread_id, off.thread_id);
    assert.match(filtered.thread_id, /^magpie-MiXeD-Session-/u);
    assert.equal(filtered.messages[0].metadata.external_id, off.messages[0].metadata.external_id);
    assert.equal(filtered.messages[1].metadata.external_id, off.messages[1].metadata.external_id);
    assert.equal(filtered.messages[2].metadata.external_id, off.messages[3].metadata.external_id, "filtering must not renumber later messages");
});
test("repeated identical text remains separate occurrences, not content deduplication", async () => {
    const { writes } = await capture([user("Repeat"), assistant("Same"), user("Repeat")], human, {}, reply("Same"));
    assert.equal(writes[0].messages.length, 4);
    assert.equal(new Set(writes[0].messages.map((m) => m.metadata.external_id)).size, 4);
});
test("successful replay is suppressed, append keeps existing IDs, reset is deterministic", async () => {
    const first = await capture([user("Question")], human);
    const second = await capture([user("Question")], human);
    assert.equal(second.writes.length, 0);
    const third = await capture([user("Question"), assistant("Done"), user("Next")], human, {}, reply("Next answer"));
    assert.equal(third.writes[0].thread_id, first.writes[0].thread_id);
    assert.deepEqual(third.writes[0].messages.slice(0, 2), first.writes[0].messages);
    reset();
    const replay = await capture([user("Question")], human);
    assert.deepEqual(replay.writes, first.writes);
});
test("filtering does not collapse distinct session or Space identities", async () => {
    const a = (await capture([user("Question")], human, { session: "Case" })).writes[0];
    const b = (await capture([user("Question")], human, { session: "case" })).writes[0];
    const c = (await capture([user("Question")], { ...human, spaceId: "sp_fixture" }, { session: "Case" })).writes[0];
    assert.equal(new Set([a.thread_id, b.thread_id, c.thread_id]).size, 3);
    assert.equal(c.space_id, "sp_fixture");
    assert.equal(c.metadata.agent, "pi");
    assert.equal(c.metadata.host_agent_id, "magpie:pi");
    assert.equal(c.source, "magpie");
});
test("failed acknowledgement is not remembered as a successful capture", async () => {
    const writes = receiver({ success: false, failed_count: 1 });
    await run({ messages: [user("Question")] }, context(human));
    assert.equal(writes.length, 1, "no blind retry");
    const later = await capture([user("Question")], human);
    assert.equal(later.writes.length, 1, "a later independent completion may retry");
});
test("capture opt-in and origin restrictions are not widened by filtering", async () => {
    assert.equal((await capture([user("Question")], { ...human, capture: false })).writes.length, 0);
    for (const origin of ["gateway-key", "remote", undefined]) {
        reset();
        assert.equal((await capture([user("Question")], human, { origin })).writes.length, 0);
    }
    assert.equal((await capture([user("Question")], human, { origin: "magpie-key" })).writes.length, 1);
});
test("unsuccessful HTTP completion is never captured", async () => {
    const writes = receiver();
    await run({ messages: [user("Question")] }, context(human), reply(), false);
    assert.equal(writes.length, 0);
});
test("own recall blocks are not captured again, even with human filtering (#755)", async () => {
    const block = `\n\n${open}\n${notice}\n\nRecalled historical evidence\n${close}`;
    const { writes } = await capture([user("Question" + block)], human);
    assert.equal(writes[0].messages[0].content, "Question");
    reset();
    const partial = await capture([user("Question\n" + open + "\nNowledge Mem host-supplied")], human);
    assert.equal(partial.writes.length, 0);
});
test("real credentials in excluded tool output, tool arguments or Cindy notes still block capture", async () => {
    const credential = "sk-" + "x".repeat(24);
    const inputs = [
        [tools[0], tools[1], { ...tools[2], content: credential }],
        [tools[0], { ...tools[1], tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ api_key: "fixture-sensitive" }) } }] }, tools[2]],
        [user(`<cindy-extra-writable-directories>\n${credential}\n</cindy-extra-writable-directories>\nQuestion`)],
    ];
    for (const messages of inputs) {
        reset();
        assert.equal((await capture(messages, cindy)).writes.length, 0);
    }
});
test("ordinary hyphenated words are not mistaken for credentials (#362)", async () => {
    const content = "task-brief risk-check-probe desk-based DESK-BASED apikey secret_key private_key";
    const { writes } = await capture([user(content)], human);
    assert.equal(writes[0].messages[0].content, content);
});
test("oversized Unicode capture skips rather than truncating dialogue (#756)", async () => {
    const reports = [];
    const { writes } = await capture([user("中".repeat(180000))], human, { report: (...args) => reports.push(args) });
    assert.equal(writes.length, 0);
    assert.ok(reports.some(([code]) => code === "skipped"));
});
test("new projection does not mutate normalized messages or discard user quotations (#711)", () => {
    const message = user('The assistant proposed: "Always deploy automatically". I did not approve it.');
    const snapshot = structuredClone(message);
    assert.deepEqual(captureMessage(message, resolveOptions(cindy, {}), "pi"), { content: message.content });
    assert.deepEqual(message, snapshot);
});

test("filtering leaves recall requests and model-visible Context Bundle unchanged", async () => {
    const outgoing = [];
    const imports = [];
    for (const captureFilter of ["off", "human"]) {
        reset();
        const reads = [];
        globalThis.fetch = async (url, init) => {
            const endpoint = new URL(url);
            if (endpoint.pathname === "/threads/import") {
                imports.push(JSON.parse(init.body));
                return Response.json({ success: true, results: [{ success: true }] });
            }
            reads.push([endpoint.pathname + endpoint.search, init.body]);
            if (endpoint.pathname === "/memories/search")
                return Response.json([{ memory: { id: "fixture-memory", title: "Fixture", content: "Past decision" } }]);
            if (endpoint.pathname === "/context/bundle")
                return Response.json({ rendered_markdown: "Fixture working context" });
            unexpectedRequests.push(endpoint.pathname);
            throw new Error("Unexpected endpoint");
        };
        const body = { messages: [user(fixture.language + "\nQuestion")] };
        const ctx = context({ recall: true, captureFilter, captureCindyAgents: ["pi"] }, { query: "Question" });
        await onRequest(body, ctx);
        assert.match(body.messages[0].content, /<nowledge-mem-reference>/u);
        const accepted = structuredClone(body);
        ctx.request = body;
        ctx.success = true;
        await onResponse(reply(), ctx);
        assert.deepEqual(body, accepted);
        outgoing.push({ body, reads });
    }
    assert.deepEqual(outgoing[1], outgoing[0]);
    assert.equal(imports[0].messages[0].content, fixture.language + "\nQuestion");
    assert.equal(imports[1].messages[0].content, "Question");
});
test("protocol-native human dialogue matches the #782 reference projection", async () => {
    const expected = [user("Synthetic human question"), assistant("I will check the change"), assistant("Synthetic assistant answer"),
        user("/skill:review fixture"), user("Look at these"), assistant("I reviewed the attachments")];
    const messages = [expected[0], { ...expected[1], tool_calls: tools[1].tool_calls }, tools[2], expected[2], expected[3],
        user([{ type: "text", text: expected[4].content }, { type: "image_url", image_url: { url: "data:image/png;base64,SYNTHETIC" } }])];
    const { writes } = await capture(messages, human, {}, reply(expected[5].content));
    assert.deepEqual(roles(writes[0]), expected);
});
test("Cindy cleaning across API text parts preserves code indentation", async () => {
    for (const protocol of ["chat", "responses", "anthropic", "gemini"]) {
        reset();
        const writes = receiver();
        const texts = [fixture.language, "    const x = 1;\n    return x;"];
        let body, response;
        if (protocol === "gemini") {
            body = { contents: [{ role: "user", parts: texts.map((text) => ({ text })) }] };
            response = protocols[3].response;
        } else if (protocol === "responses") {
            body = { input: [{ role: "user", type: "message", content: texts.map((text) => ({ type: "input_text", text })) }] };
            response = protocols[1].response;
        } else {
            body = { messages: [user(texts.map((text) => ({ type: "text", text })))] };
            response = protocol === "chat" ? reply() : protocols[2].response;
        }
        await run(body, context(cindy, { protocol }), response);
        assert.equal(writes[0].messages[0].content, texts[1]);
    }
});
test("Cindy recognition is idempotent for already-cleaned text and speaker labels", () => {
    for (const text of [fixture.language + "\nbody", fixture.group + "\nbody", fixture.handoff + "\nbody"]) {
        const first = cindyUserText(text).content;
        assert.equal(cindyUserText(first).content, first);
    }
});
