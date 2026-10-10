import "./chat.css";

type Source = { id: string; title: string; evidence: "read" | "search" | "graph" };
type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  activity?: string[];
};
type Conversation = { id: string; title: string; messages: Message[]; updated: number };
type ChatResponse = {
  answer: string;
  sources: Source[];
  activity: string[];
};
type Api = (path: string, options?: RequestInit) => Promise<any>;

const STORAGE_KEY = "secondbrain.chat.conversations.v1";
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
const pageUrl = (id: string) => "/wiki/" + encodeURIComponent(id);

function load(): Conversation[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(item => item && typeof item.id === "string" && Array.isArray(item.messages))
      .slice(0, 20);
  } catch {
    return [];
  }
}

function save(conversations: Conversation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.slice(0, 20)));
  } catch {
    // Chat remains usable for this tab when browser storage is unavailable.
  }
}

function freshConversation(): Conversation {
  return { id: crypto.randomUUID(), title: "New conversation", messages: [], updated: Date.now() };
}

export function renderChat(main: Element, api: Api): () => void {
  let conversations = load();
  if (!conversations.length) conversations = [freshConversation()];
  let activeId = conversations[0].id;
  let busy = false;
  let error = "";
  let alive = true;

  const current = () => conversations.find(item => item.id === activeId) || conversations[0];
  const persist = () => {
    conversations.sort((a, b) => b.updated - a.updated);
    save(conversations);
  };
  const render = () => {
    const conversation = current();
    main.innerHTML = `<section class="chat-page" aria-labelledby="chat-title">
      <aside class="chat-history" aria-label="Saved conversations">
        <div class="chat-history-heading"><span>CONVERSATIONS</span><button type="button" data-action="new" ${busy ? "disabled" : ""}>New</button></div>
        <div class="chat-history-list">${conversations.map(item => `<button type="button" data-conversation="${esc(item.id)}" class="${item.id === activeId ? "active" : ""}" ${busy ? "disabled" : ""}><span>${esc(item.title)}</span><small>${item.messages.length} messages</small></button>`).join("")}</div>
        <button type="button" class="chat-delete" data-action="delete" ${conversation.messages.length && !busy ? "" : "disabled"}>Delete conversation</button>
      </aside>
      <div class="chat-workspace">
        <div class="chat-heading"><div><div class="eyebrow">READ-ONLY WIKI CHAT</div><h1 id="chat-title">Ask, then follow the evidence.</h1><p>The assistant searches and reads this wiki. It cannot change pages, and conversations stay in this browser.</p></div><span class="chat-boundary">No write tools</span></div>
        <div class="chat-messages" role="log" aria-live="polite">
          ${conversation.messages.length ? conversation.messages.map(message => `<article class="chat-message ${message.role}"><div class="chat-role">${message.role === "user" ? "You" : "Wiki assistant"}</div><p>${esc(message.content)}</p>${message.activity?.length ? `<details><summary>${message.activity.length} wiki action${message.activity.length === 1 ? "" : "s"}</summary><ul>${message.activity.map(item => `<li>${esc(item)}</li>`).join("")}</ul></details>` : ""}${message.sources?.length ? `<div class="chat-sources"><span>Sources</span>${message.sources.map(source => `<a href="${pageUrl(source.id)}">${esc(source.title)} <small>${esc(source.evidence)}</small></a>`).join("")}</div>` : ""}</article>`).join("") : `<div class="chat-empty"><span>✳</span><h2>Start with a real question.</h2><p>Try asking where a project stands, then ask a follow-up about one source.</p></div>`}
          ${busy ? `<div class="chat-thinking"><i></i>Searching and reading…</div>` : ""}
        </div>
        ${error ? `<div class="chat-error" role="alert"><span>${esc(error)}</span><button type="button" data-action="retry">Retry</button></div>` : ""}
        <form class="chat-composer"><label for="chat-input">Message</label><textarea id="chat-input" maxlength="4000" rows="2" placeholder="Ask this wiki…" ${busy ? "disabled" : ""}></textarea><button class="primary" ${busy ? "disabled" : ""}>Send →</button><small>Up to 12 recent messages are sent. Chats are saved only in local browser storage.</small></form>
      </div>
    </section>`;
    main.querySelectorAll<HTMLButtonElement>("[data-conversation]").forEach(button => {
      button.onclick = () => {
        activeId = button.dataset.conversation!;
        error = "";
        render();
      };
    });
    main.querySelector<HTMLButtonElement>('[data-action="new"]')!.onclick = () => {
      const next = freshConversation();
      conversations.unshift(next);
      activeId = next.id;
      error = "";
      persist();
      render();
    };
    main.querySelector<HTMLButtonElement>('[data-action="delete"]')!.onclick = () => {
      conversations = conversations.filter(item => item.id !== activeId);
      if (!conversations.length) conversations = [freshConversation()];
      activeId = conversations[0].id;
      error = "";
      persist();
      render();
    };
    const form = main.querySelector<HTMLFormElement>(".chat-composer")!;
    form.onsubmit = event => {
      event.preventDefault();
      const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
      const content = input.value.trim();
      if (!content || busy) return;
      const item = current();
      item.messages.push({ role: "user", content });
      item.messages = item.messages.slice(-24);
      item.title = item.messages.filter(message => message.role === "user")[0]?.content.slice(0, 54) || "New conversation";
      item.updated = Date.now();
      error = "";
      persist();
      void requestAnswer();
    };
    const retry = main.querySelector<HTMLButtonElement>('[data-action="retry"]');
    if (retry) retry.onclick = () => void requestAnswer();
    if (!busy) main.querySelector<HTMLTextAreaElement>("#chat-input")?.focus();
    main.querySelector(".chat-messages")?.scrollTo({ top: 1_000_000 });
  };

  const requestAnswer = async () => {
    if (busy) return;
    const conversation = current();
    const requestId = conversation.id;
    busy = true;
    error = "";
    render();
    try {
      const messages = conversation.messages
        .filter(message => message.role === "user" || message.role === "assistant")
        .slice(-12)
        .map(({ role, content }) => ({ role, content }));
      const result = (await api("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      })) as ChatResponse;
      if (!alive || activeId !== requestId) return;
      conversation.messages.push({
        role: "assistant",
        content: result.answer,
        sources: result.sources,
        activity: result.activity,
      });
      conversation.updated = Date.now();
      persist();
    } catch (cause) {
      if (!alive || activeId !== requestId) return;
      error = (cause as Error).message + " Your question is still here; retry when ready.";
    } finally {
      if (alive && activeId === requestId) {
        busy = false;
        render();
      }
    }
  };

  render();
  return () => {
    alive = false;
  };
}
