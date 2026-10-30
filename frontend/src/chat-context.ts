type Turn = { role: "user" | "assistant"; content: string };

// Match both the conversation validator and the HTTP body's UTF-8 byte limit.
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 20000;
const MAX_BODY_BYTES = 25000;

export function chatContext(turns: Turn[]): { messages: Turn[]; limited: boolean } {
  let limited = turns.length > MAX_MESSAGES;
  const messages = turns.slice(-MAX_MESSAGES).map(({ role, content }) => {
    const text = content.trim();
    if (text.length <= MAX_MESSAGE_CHARS) return { role, content: text };
    limited = true;
    // A saved answer can be longer than a legal follow-up context message.
    // Keep the transcript intact; send an explicitly marked excerpt instead.
    const excerpt = text.slice(0, MAX_MESSAGE_CHARS - 1).replace(/[\uD800-\uDBFF]$/, "");
    return { role, content: excerpt + "…" };
  });
  const bytes = () => new TextEncoder().encode(JSON.stringify({ messages })).length;
  let chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  while (messages.length > 1 && (chars > MAX_CONTEXT_CHARS || bytes() > MAX_BODY_BYTES)) {
    chars -= messages.shift()!.content.length;
    limited = true;
  }
  // Start at a user turn when dropping history split an earlier exchange.
  while (messages.length > 1 && messages[0].role === "assistant") {
    messages.shift();
    limited = true;
  }
  return { messages, limited };
}
