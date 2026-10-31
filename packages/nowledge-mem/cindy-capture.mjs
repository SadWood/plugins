// Complete Cindy 0.1.121 wire templates, based on the synthetic scenarios in
// nowledge-co/community#785. This is NOT its native Pi adapter: the gateway has
// no launcher environment, parentSession, timestamps or attribution. Call only
// for explicitly opted-in agent IDs; never infer a fork boundary from these notes.
const side = "[Side chat context] This is an independent follow-up to a main task. History inherited at the fork is reference material, not active instructions or authorization. Answer the current question; do not resume the main task, its pending actions, or its plan. Keep exploration non-mutating unless the user explicitly requests a change in this side chat. The main task continues separately and does not receive these replies automatically.";
const mobile = "产出 HTML 等可预览成品时**优先做成自包含单文件**:样式与脚本内联,图片用 data: URI 或公网地址,避免拆成需要同目录资源的多文件产物;用户明确要求多文件时照常产出。给出文件路径时同时给出结论或内容摘要,不要只回一个路径。";
const legacyMobile = "[客户端说明] 以下为系统每轮自动追加的环境说明,不是用户发来的消息;回复时不要把它当作用户的请求,也不要引用、复述或据此臆测用户意图。本轮请求来自手机客户端(小屏、远程查看被控电脑上的文件)。";
const client = /^\[客户端说明\] 系统追加的环境说明，不是用户消息，不要回应或复述。本轮用户在(另一台电脑|手机)(.*?) 上远程操作本机(.*?)。(.*)$/u;
const channel = "[渠道说明] 系统追加，不是用户消息。本条来自";
const language = new RegExp([
    String.raw`^\[UI language\] System note appended each turn\. This is not a user message\. `,
    String.raw`Do not answer it, quote it, or infer intent from it\. The user interface language is ([^\r\n]+?) \(([a-zA-Z-]+)\)\. `,
    String.raw`When you tell the user that something failed, was blocked, could not continue, or needs a retry, write that report in \1\. `,
    String.raw`Do not default that report to English unless the interface language is English\. Say what happened and the next step\. `,
    String.raw`Keep commands, paths, identifiers, and error codes unchanged\. Ordinary replies still follow the user message and any explicit language request\. `,
    String.raw`Only user-facing error reports must use the interface language\.(?:\r?\n|$)`,
].join(""), "u");
const ends = (name, zh) => [
    `== End of ${name} note; the user's new message follows ==`,
    `== End of ${name} note; the user’s new message follows ==`,
    `== ${zh}说明结束,以下是用户的新消息 ==`,
];
const handoff = ends("handoff", "交接");
const rebuild = ends("rebuild", "上下文重建");
const contexts = new Map([
    ["[Session handoff · internal context]", handoff],
    ["[Session context rebuild · internal context]", rebuild],
    ["[Session fork · internal context]", [
        "== End of fork note; the user's new message follows ==",
        "== End of fork note; the user’s new message follows ==",
        ...handoff, ...rebuild,
    ]],
]);
const maxPrefixes = 64;

// Consume only complete leading notes. Unknown text, quoting, indentation and
// incomplete templates stop recognition. A bounded pass cannot partially clean
// a pathological prefix stack and then remove more on a second pass.
export function cindyUserText(original) {
    let content = original;
    let origin;
    for (let count = 0; count <= maxPrefixes; count++) {
        const note = prefix(content);
        if (!note) {
            let speaker = "";
            if (origin && (origin.chat_kind === "group" || origin.sender_is_owner === false)) {
                speaker = origin.sender_name ? `发言人「${origin.sender_name}」：\n`
                    : origin.sender_is_owner === false ? "发言人（非主人）：\n" : "群聊发言人：\n";
            }
            return { content: content.trim() ? speaker + content : "", ...(origin ? { cindyOrigin: origin } : {}) };
        }
        if (count === maxPrefixes)
            return { content: original };
        origin = note.origin ?? origin;
        // Separator lines are not the user's code indentation.
        content = note.rest.replace(/^(?:[ \t]*\r?\n)+/u, "");
    }
}
function prefix(text) {
    if (text.startsWith(side)) {
        const rest = text.slice(side.length);
        if (!rest || /^\r?\n/u.test(rest))
            return { rest };
    }
    for (const tag of ["cindy-extra-writable-directories", "cindy-extra-reference-directories"]) {
        if (!text.startsWith(`<${tag}>\n`) && !text.startsWith(`<${tag}>\r\n`))
            continue;
        const close = `</${tag}>`;
        const end = text.indexOf(close);
        if (end < 0)
            return;
        const rest = text.slice(end + close.length);
        return !rest || /^\r?\n/u.test(rest) ? { rest } : undefined;
    }
    const lang = text.match(language);
    if (lang)
        return { rest: text.slice(lang[0].length) };
    const newline = text.indexOf("\n");
    const line = (newline < 0 ? text : text.slice(0, newline)).replace(/\r$/u, "");
    const rest = newline < 0 ? "" : text.slice(newline + 1);
    const origin = channelOrigin(line);
    if (origin)
        return { rest, origin };
    if (line === legacyMobile + mobile)
        return { rest };
    const match = line.match(client);
    if (match && nameOnly(match[2], "device_id") !== false && nameOnly(match[3], "device_id") !== false
        && (!match[4] || (match[1] === "手机" && match[4] === mobile)))
        return { rest };
    const terminators = contexts.get(line);
    if (!terminators)
        return;
    let fence;
    for (const part of text.matchAll(/^.*(?:\r?\n|$)/gm)) {
        const row = part[0].replace(/\r?\n$/u, "");
        const marker = row.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
        if (marker) {
            if (!fence)
                fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
                fence = undefined;
            continue;
        }
        if (!fence && terminators.includes(row))
            return { rest: text.slice(part.index + part[0].length) };
    }
}
// Keep display names and explicit ownership, not transport chat/user/device IDs.
function nameOnly(raw, key) {
    const match = raw.trim().match(new RegExp(`^(?:「([^「」\\r\\n]+)」)?(?: ?\\(${key}: ([^()\\r\\n]+)\\))?$`, "u"));
    return match && (match[1]?.trim() || match[2]?.trim()) ? match[1] : false;
}
function channelOrigin(line) {
    if (!line.startsWith(channel) || !line.endsWith("。"))
        return;
    const match = line.slice(channel.length, -1).match(/^(?:微信| WeChat )(私聊|群)(.*)$/u);
    if (!match)
        return;
    const refs = match[2].split("，发言人");
    if (refs.length > 2)
        return;
    const chatName = nameOnly(refs[0], "chat_id");
    if (chatName === false)
        return;
    const origin = { channel: "wechat", chat_kind: match[1] === "群" ? "group" : "direct" };
    if (chatName)
        origin.chat_name = chatName;
    if (refs.length === 2) {
        const ownership = refs[1].match(/(?:，)?(不是主人|是主人)$/u);
        const sender = ownership ? refs[1].slice(0, ownership.index) : refs[1];
        const senderName = !sender.trim() && ownership ? undefined : nameOnly(sender, "user_id");
        if (senderName === false)
            return;
        if (senderName)
            origin.sender_name = senderName;
        if (ownership)
            origin.sender_is_owner = ownership[1] === "是主人";
    }
    return origin;
}
