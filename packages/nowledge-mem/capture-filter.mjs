// Capture-only projection. The protocol parser has already checked completion,
// paired tools and removed this plugin's recall blocks. Never use this on model
// input or before the secret scan: excluded tools may still contain credentials.
import { cindyUserText } from "./cindy-capture.mjs";

export function captureMessage(message, options, agent) {
    if (options.captureFilter !== "human") {
        const content = message.content.trim();
        if (!content || (!options.captureTools && (message.role === "tool" || message.tool_calls?.length)))
            return;
        return { content };
    }
    if (message.role !== "user" && message.role !== "assistant")
        return;
    // Keep human-facing commentary even when the same message calls a tool.
    // Preserve indentation and full text; do not invent attachment placeholders.
    const projected = message.role === "user" && options.captureCindyAgents.includes(agent)
        ? cindyUserText(message.content) : { content: message.content };
    return projected.content.trim() ? projected : undefined;
}
