import "./chat.css";

type Source = { id: string; title: string; evidence: "read" };
type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  activity?: string[];
};
type Conversation = { id: string; title: string; messages: Message[]; updated: number };
type Tombstone = { id: string; deleted: number };
type ChatResponse = {
  answer: string;
  sources: Source[];
  activity: string[];
};
type Api = (path: string, options?: RequestInit) => Promise<any>;

const STORAGE_KEY = "secondbrain.chat.conversations.v1";
const DELETED_STORAGE_KEY = "secondbrain.chat.deleted.v1";
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
const pageUrl = (id: string) => "/wiki/" + encodeURIComponent(id);

const MAX_CONVERSATIONS = 20;
const MAX_TOMBSTONES = 100;
const MAX_MESSAGES = 24;
// Each backend wiki action can add at most one read source and activity entry.
const MAX_WIKI_ACTIONS = 8;
// Failed browser writes must not discard a chat when following a wiki source.
// This bounded fallback disappears on document reload and is never sent to an archive.
let tabConversations: Conversation[] | undefined;
let tabTombstones: Tombstone[] | undefined;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validMessage(value: unknown): value is Message {
  if (!record(value) || (value.role !== "user" && value.role !== "assistant") ||
      typeof value.content !== "string" || !value.content.trim()) return false;
  if (value.role === "user" && value.content.length > 4000) return false;
  if (value.sources !== undefined && (!Array.isArray(value.sources) ||
      !value.sources.every(source => record(source) && typeof source.id === "string" &&
        /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,159}$/u.test(source.id) && typeof source.title === "string" &&
        source.evidence === "read"))) return false;
  if (value.activity !== undefined && (!Array.isArray(value.activity) ||
      !value.activity.every(item => typeof item === "string"))) return false;
  return true;
}

function boundedMessages(messages: Message[]): Message[] {
  return messages.slice(-MAX_MESSAGES).map(message => ({
    role: message.role,
    content: message.content,
    ...(message.sources === undefined ? {} : {
      sources: message.sources.slice(0, MAX_WIKI_ACTIONS).map(({ id, title, evidence }) => ({ id, title, evidence })),
    }),
    ...(message.activity === undefined ? {} : { activity: message.activity.slice(0, MAX_WIKI_ACTIONS) }),
  }));
}

function parseConversations(raw: string | null): Conversation[] {
  try {
    const value: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(value)) return [];
    const conversations: Conversation[] = [];
    const ids = new Set<string>();
    for (const item of value) {
      if (!record(item) || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
          typeof item.title !== "string" || typeof item.updated !== "number" ||
          !Number.isFinite(item.updated) || item.updated < 0 ||
          !Array.isArray(item.messages) || !item.messages.every(validMessage)) continue;
      ids.add(item.id);
      conversations.push({ id: item.id, title: item.title, updated: item.updated,
        messages: boundedMessages(item.messages) });
      if (conversations.length === MAX_CONVERSATIONS) break;
    }
    return conversations;
  } catch {
    return [];
  }
}

function parseTombstones(raw: string | null): Tombstone[] {
  try {
    const value: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(value)) return [];
    const tombstones: Tombstone[] = [];
    const ids = new Set<string>();
    for (const item of value) {
      if (!record(item) || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
          typeof item.deleted !== "number" || !Number.isFinite(item.deleted) || item.deleted < 0) continue;
      ids.add(item.id);
      tombstones.push({ id: item.id, deleted: item.deleted });
      if (tombstones.length === MAX_TOMBSTONES) break;
    }
    return tombstones;
  } catch {
    return [];
  }
}

function applyTombstones(conversations: Conversation[], tombstones: Tombstone[]): Conversation[] {
  const deleted = new Map(tombstones.map(item => [item.id, item.deleted]));
  return conversations.filter(item => (deleted.get(item.id) ?? -1) < item.updated);
}

function readPersistent(): { conversations: Conversation[]; tombstones: Tombstone[]; unavailable: boolean } {
  try {
    const tombstones = parseTombstones(localStorage.getItem(DELETED_STORAGE_KEY));
    return {
      conversations: applyTombstones(parseConversations(localStorage.getItem(STORAGE_KEY)), tombstones),
      tombstones,
      unavailable: false,
    };
  } catch {
    return { conversations: [], tombstones: [], unavailable: true };
  }
}

function load(): { conversations: Conversation[]; tombstones: Tombstone[]; unavailable: boolean } {
  if (tabConversations) return {
    conversations: tabConversations,
    tombstones: tabTombstones || [],
    unavailable: true,
  };
  return readPersistent();
}

function save(conversations: Conversation[], tombstones: Tombstone[]): boolean {
  try {
    // Persist deletion intent before the conversation snapshot. A stale tab can then
    // merge without resurrecting a conversation if the second write is interrupted.
    localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify(tombstones));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    tabConversations = undefined;
    tabTombstones = undefined;
    return true;
  } catch {
    tabConversations = conversations;
    tabTombstones = tombstones;
    return false;
  }
}

function freshConversation(): Conversation {
  return { id: crypto.randomUUID(), title: "New conversation", messages: [], updated: Date.now() };
}

export function renderChat(main: Element, api: Api): () => void {
  const loaded = load();
  let conversations = loaded.conversations;
  let tombstones = loaded.tombstones;
  let storageUnavailable = loaded.unavailable;
  if (!conversations.length) conversations = [freshConversation()];
  let activeId = conversations[0].id;
  const dirtyIds = new Set<string>();
  const deletedIds = new Map<string, number>();
  let busy = false;
  let error = "";
  let alive = true;

  const current = () => conversations.find(item => item.id === activeId) || conversations[0];
  const persist = () => {
    const stored = readPersistent();
    const merged = new Map(stored.unavailable
      ? conversations.map(item => [item.id, item] as const)
      : stored.conversations.map(item => [item.id, item] as const));
    for (const item of conversations) {
      if (!dirtyIds.has(item.id)) continue;
      const other = merged.get(item.id);
      if (!other || item.updated >= other.updated) merged.set(item.id, item);
    }
    const deleted = new Map<string, number>();
    for (const item of [...stored.tombstones, ...tombstones]) {
      deleted.set(item.id, Math.max(deleted.get(item.id) ?? -1, item.deleted));
    }
    for (const [id, timestamp] of deletedIds) {
      deleted.set(id, Math.max(deleted.get(id) ?? -1, timestamp));
    }
    for (const [id, item] of merged) {
      if ((deleted.get(id) ?? -1) >= item.updated) merged.delete(id);
    }
    tombstones = [...deleted].map(([id, timestamp]) => ({ id, deleted: timestamp }))
      .sort((a, b) => b.deleted - a.deleted)
      .slice(0, MAX_TOMBSTONES);
    conversations = [...merged.values()].sort((a, b) => b.updated - a.updated);
    if (!conversations.length) {
      const replacement = freshConversation();
      conversations = [replacement];
      activeId = replacement.id;
    } else if (!conversations.some(item => item.id === activeId)) {
      activeId = conversations[0].id;
    }
    const active = current();
    // Keep the active conversation even if an earlier device saved future timestamps.
    conversations = [active, ...conversations.filter(item => item.id !== active.id)]
      .slice(0, MAX_CONVERSATIONS);
    conversations.forEach(item => { item.messages = boundedMessages(item.messages); });
    storageUnavailable = !save(conversations, tombstones);
    if (!storageUnavailable) {
      dirtyIds.clear();
      deletedIds.clear();
    }
  };
  const render = (focusComposer = false) => {
    const conversation = current();
    const retryNotice = error || (!busy && conversation.messages[conversation.messages.length - 1]?.role === "user"
      ? "This question has no saved answer. You can retry it when ready." : "");
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
        ${retryNotice ? `<div class="chat-error" role="alert"><span>${esc(retryNotice)}</span><button type="button" data-action="retry">Retry</button></div>` : ""}
        ${storageUnavailable ? `<div class="chat-storage-notice" role="status">Browser storage is unavailable. New messages stay only in this tab until it is reloaded; previously saved conversations may remain after deletion.</div>` : ""}
        <form class="chat-composer"><label for="chat-input">Message</label><textarea id="chat-input" maxlength="4000" rows="2" placeholder="Ask this wiki…" ${busy ? "disabled" : ""}></textarea><button class="primary" ${busy ? "disabled" : ""}>Send →</button><small>Up to 12 recent messages are sent. ${storageUnavailable ? "Chats are session-only in this tab." : "Chats are saved only in local browser storage."}</small></form>
      </div>
    </section>`;
    main.querySelectorAll<HTMLButtonElement>("[data-conversation]").forEach(button => {
      button.onclick = () => {
        activeId = button.dataset.conversation!;
        error = "";
        persist(); // Keep the selected conversation when leaving or reloading Chat.
        render(false);
      };
    });
    main.querySelector<HTMLButtonElement>('[data-action="new"]')!.onclick = () => {
      const next = freshConversation();
      conversations.unshift(next);
      activeId = next.id;
      dirtyIds.add(next.id);
      error = "";
      persist();
      render(true);
    };
    main.querySelector<HTMLButtonElement>('[data-action="delete"]')!.onclick = () => {
      const removed = current();
      deletedIds.set(removed.id, Math.max(Date.now(), removed.updated + 1));
      dirtyIds.delete(removed.id);
      conversations = conversations.filter(item => item.id !== activeId);
      if (!conversations.length) conversations = [freshConversation()];
      activeId = conversations[0].id;
      error = "";
      persist();
      render(false);
    };
    const form = main.querySelector<HTMLFormElement>(".chat-composer")!;
    form.onsubmit = event => {
      event.preventDefault();
      const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
      const content = input.value.trim();
      if (!content || busy) return;
      const item = current();
      item.messages.push({ role: "user", content });
      item.messages = item.messages.slice(-MAX_MESSAGES);
      item.title = item.messages.filter(message => message.role === "user")[0]?.content.slice(0, 54) || "New conversation";
      item.updated = Math.max(Date.now(), item.updated + 1);
      dirtyIds.add(item.id);
      error = "";
      persist();
      void requestAnswer();
    };
    const retry = main.querySelector<HTMLButtonElement>('[data-action="retry"]');
    if (retry) retry.onclick = () => void requestAnswer();
    if (!busy && focusComposer)
      main.querySelector<HTMLTextAreaElement>("#chat-input")?.focus({ preventScroll: true });
    main.querySelector(".chat-messages")?.scrollTo({ top: 1_000_000 });
  };

  const requestAnswer = async () => {
    if (busy) return;
    const conversation = current();
    const requestId = conversation.id;
    busy = true;
    error = "";
    render(false);
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
      conversation.updated = Math.max(Date.now(), conversation.updated + 1);
      dirtyIds.add(conversation.id);
      persist();
    } catch (cause) {
      if (!alive || activeId !== requestId) return;
      error = (cause as Error).message + " Your question is still here; retry when ready.";
    } finally {
      if (alive && activeId === requestId) {
        busy = false;
        render(true);
      }
    }
  };

  render(false);
  return () => {
    alive = false;
  };
}
