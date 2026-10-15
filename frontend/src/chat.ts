import "./chat.css";
import { chatContext } from "./chat-context";

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
let tabDirtyIds: Set<string> | undefined;
let reloadBlocker: () => "draft" | "reply" | undefined = () => undefined;
export function chatReloadBlocker() {
  const active = reloadBlocker();
  if (active) return active;
  // Failed writes survive SPA navigation only in this document. Protect them
  // even after Chat is unmounted, until persisted or deliberately deleted.
  if (tabConversations?.some(item => item.messages.length > 0 && tabDirtyIds?.has(item.id)))
    return "storage";
  return undefined;
}
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
  const deleted = new Set(tombstones.map(item => item.id));
  return conversations.filter(item => !deleted.has(item.id));
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

function save(conversations: Conversation[], tombstones: Tombstone[], dirtyIds: Set<string>): boolean {
  try {
    // Persist deletion intent before the conversation snapshot. A stale tab can then
    // merge without resurrecting a conversation if the second write is interrupted.
    localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify(tombstones));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    tabConversations = undefined;
    tabTombstones = undefined;
    tabDirtyIds = undefined;
    return true;
  } catch {
    tabConversations = conversations;
    tabTombstones = tombstones;
    tabDirtyIds = new Set(conversations.filter(item => dirtyIds.has(item.id)).map(item => item.id));
    return false;
  }
}

function freshConversation(): Conversation {
  return { id: crypto.randomUUID(), title: "New conversation", messages: [], updated: Date.now() };
}

export function renderChat(main: Element, api: Api, stateChanged: () => void = () => {}): () => void {
  const loaded = load();
  let conversations = loaded.conversations;
  let tombstones = loaded.tombstones;
  let storageUnavailable = loaded.unavailable;
  if (!conversations.length) conversations = [freshConversation()];
  let activeId = conversations[0].id;
  // Preserve pending writes across SPA navigation while browser storage is full.
  // A restored in-tab snapshot must still merge its unsaved messages on recovery.
  const dirtyIds = new Set(tabDirtyIds);
  const deletedIds = new Map<string, number>();
  // Unsent text belongs to its conversation while this Chat view stays open.
  // Keep it out of saved transcripts and provider requests until Send.
  const drafts = new Map<string, string>();
  let busy = false;
  let requestController: AbortController | undefined;
  let error = "";
  let conversationNotice = "";
  let contextNotice = "";
  let alive = true;
  reloadBlocker = () => !alive ? undefined : busy ? "reply"
    : drafts.size ? "draft" : undefined;

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
    // UUIDs are never reused: a retained deletion marker wins over later stale
    // edits and answers as well as over unedited snapshots.
    for (const id of merged.keys()) {
      if (deleted.has(id)) merged.delete(id);
    }
    tombstones = [...deleted].map(([id, timestamp]) => ({ id, deleted: timestamp }))
      .sort((a, b) => b.deleted - a.deleted)
      .slice(0, MAX_TOMBSTONES);
    conversations = [...merged.values()].sort((a, b) => b.updated - a.updated);
    if (deleted.has(activeId)) {
      conversationNotice = "This conversation was deleted in another tab.";
      contextNotice = "";
    }
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
    for (const id of drafts.keys()) {
      if (!conversations.some(item => item.id === id)) drafts.delete(id);
    }
    storageUnavailable = !save(conversations, tombstones, dirtyIds);
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
        <div class="chat-history-list">${conversations.map(item => `<button type="button" data-conversation="${esc(item.id)}" class="${item.id === activeId ? "active" : ""}" ${busy ? "disabled" : ""}><span>${esc(item.title)}</span><small>${item.messages.length} message${item.messages.length === 1 ? "" : "s"}</small></button>`).join("")}</div>
        <button type="button" class="chat-delete" data-action="delete" ${conversation.messages.length && !busy ? "" : "disabled"}>Delete conversation</button>
      </aside>
      <div class="chat-workspace">
        <div class="chat-heading"><div><div class="eyebrow">READ-ONLY WIKI CHAT</div><h1 id="chat-title">Ask, then follow the evidence.</h1><p>The assistant searches and reads this wiki. It cannot change pages, and conversations stay in this browser.</p></div><span class="chat-boundary">No write tools</span></div>
        <div class="chat-messages" role="log" aria-live="polite">
          ${conversation.messages.length ? conversation.messages.map(message => `<article class="chat-message ${message.role}"><div class="chat-role">${message.role === "user" ? "You" : "Wiki assistant"}</div><p>${esc(message.content)}</p>${message.activity?.length ? `<details><summary>${message.activity.length} wiki action${message.activity.length === 1 ? "" : "s"}</summary><ul>${message.activity.map(item => `<li>${esc(item)}</li>`).join("")}</ul></details>` : ""}${message.sources?.length ? `<div class="chat-sources"><span>Sources</span>${message.sources.map(source => `<a href="${pageUrl(source.id)}">${esc(source.title)} <small>${esc(source.evidence)}</small></a>`).join("")}</div>` : ""}</article>`).join("") : `<div class="chat-empty"><span>✳</span><h2>Start with a real question.</h2><p>Try asking where a project stands, then ask a follow-up about one source.</p></div>`}
          ${busy ? `<div class="chat-thinking"><i></i>Searching and reading… <button type="button" data-action="stop">Stop reply</button></div>` : ""}
        </div>
        ${retryNotice ? `<div class="chat-error" role="alert"><span>${esc(retryNotice)}</span><button type="button" data-action="retry">Retry</button></div>` : ""}
        ${conversationNotice ? `<div class="chat-storage-notice chat-conversation-notice" role="status">${esc(conversationNotice)}</div>` : ""}
        ${contextNotice ? `<div class="chat-storage-notice chat-context-notice" role="status">${esc(contextNotice)}</div>` : ""}
        ${storageUnavailable ? `<div class="chat-storage-notice" role="status">Browser storage is unavailable. New messages stay only in this tab until it is reloaded; previously saved conversations may remain after deletion.</div>` : ""}
        <form class="chat-composer"><label for="chat-input">Message</label><textarea id="chat-input" maxlength="4000" rows="2" placeholder="Ask this wiki…" ${busy ? "disabled" : ""}></textarea><button class="primary" ${busy ? "disabled" : ""}>Send →</button><small>Up to 12 recent messages are sent. ${storageUnavailable ? "Chats are session-only in this tab." : "Chats are saved only in local browser storage."}</small></form>
      </div>
    </section>`;
    main.querySelectorAll<HTMLButtonElement>("[data-conversation]").forEach(button => {
      button.onclick = () => {
        activeId = button.dataset.conversation!;
        error = "";
        conversationNotice = "";
        contextNotice = "";
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
      conversationNotice = "";
      contextNotice = "";
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
      conversationNotice = "";
      contextNotice = "";
      persist();
      render(false);
    };
    const form = main.querySelector<HTMLFormElement>(".chat-composer")!;
    const composer = form.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.value = drafts.get(activeId) || "";
    composer.oninput = () => {
      if (composer.value) drafts.set(activeId, composer.value);
      else drafts.delete(activeId);
      stateChanged();
    };
    form.onsubmit = event => {
      event.preventDefault();
      const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
      const content = input.value.trim();
      if (!content || busy) return;
      drafts.delete(activeId);
      let item = current();
      const stored = readPersistent();
      if (stored.tombstones.some(deleted => deleted.id === item.id)) {
        item = freshConversation();
        conversations.unshift(item);
        activeId = item.id;
        conversationNotice = "The previous conversation was deleted in another tab. Your message started a new conversation.";
      }
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
    const stop = main.querySelector<HTMLButtonElement>('[data-action="stop"]');
    if (stop) stop.onclick = () => requestController?.abort();
    if (!busy && focusComposer)
      main.querySelector<HTMLTextAreaElement>("#chat-input")?.focus({ preventScroll: true });
    main.querySelector(".chat-messages")?.scrollTo({ top: 1_000_000 });
    stateChanged();
  };

  const requestAnswer = async () => {
    if (busy) return;
    const conversation = current();
    // Retry uses the same read boundary as a new submission. A transcript
    // deleted in another tab must not be sent back to the provider.
    if (readPersistent().tombstones.some(item => item.id === conversation.id)) {
      error = "";
      persist();
      render(true);
      return;
    }
    const requestId = conversation.id;
    const controller = new AbortController();
    requestController = controller;
    const { messages, limited } = chatContext(conversation.messages);
    contextNotice = limited
      ? "Only recent conversation text and shortened excerpts were sent for this reply. Your saved messages are unchanged."
      : "";
    busy = true;
    error = "";
    render(false);
    try {
      const result = (await api("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      })) as ChatResponse;
      if (!alive || activeId !== requestId || controller.signal.aborted) return;
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
      if (readPersistent().tombstones.some(item => item.id === requestId)) {
        persist();
        return;
      }
      error = (controller.signal.aborted ? "Reply stopped." : (cause as Error).message)
        + " Your question is still here; retry when ready.";
    } finally {
      if (requestController === controller) requestController = undefined;
      if (alive) {
        busy = false;
        render(true);
      }
    }
  };

  render(false);
  return () => {
    alive = false;
    requestController?.abort();
    stateChanged();
  };
}
