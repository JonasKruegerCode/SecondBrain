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
let tabBaselines: Map<string, string> | undefined;
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
        /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,159}$/u.test(source.id) && typeof source.title === "string" &&
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

type ChatRoot = { version: 1; conversations: Conversation[]; tombstones: Tombstone[] };
type Stored = { conversations: Conversation[]; tombstones: Tombstone[]; unavailable: boolean };
let stagedRoot: Stored | undefined;
let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open("secondbrain.chat.v1", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("chat"); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      abandoned = true;
      reject(new Error("Chat storage upgrade is blocked"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  }).catch(cause => { database = undefined; throw cause; });
  return database;
}
function normalizedRoot(value: unknown): ChatRoot {
  if (!record(value) || value.version !== 1) throw new Error("Unsupported chat storage");
  const tombstones = parseTombstones(JSON.stringify(value.tombstones));
  return { version: 1, conversations: applyTombstones(
    parseConversations(JSON.stringify(value.conversations)), tombstones), tombstones };
}
function readPersistent(): Stored {
  if (!stagedRoot) throw new Error("Chat storage read outside transaction");
  return stagedRoot;
}
function retainFallback(conversations: Conversation[], tombstones: Tombstone[],
  dirtyIds: Set<string>, baselines: Map<string, string>) {
  tabConversations = conversations;
  tabTombstones = tombstones;
  tabDirtyIds = new Set(conversations.filter(item => dirtyIds.has(item.id)).map(item => item.id));
  tabBaselines = new Map([...baselines].filter(([id]) => dirtyIds.has(id)));
}

const transcript = (item: Conversation | undefined) => JSON.stringify(item?.messages ?? null);

function freshConversation(): Conversation {
  return { id: crypto.randomUUID(), title: "New conversation", messages: [], updated: Date.now() };
}

export function renderChat(main: Element, api: Api, stateChanged: () => void = () => {},
  onReady: () => void = () => {}): () => void {
  let conversations = tabConversations || [freshConversation()];
  let tombstones = tabTombstones || [];
  let storageUnavailable = !!tabConversations;
  let activeId = conversations[0]?.id || "";
  const dirtyIds = new Set(tabDirtyIds);
  const baselines = new Map(tabBaselines);
  const deletedIds = new Map<string, number>();
  const drafts = new Map<string, string>();
  let busy = false;
  let storagePending = true;
  let requestController: AbortController | undefined;
  let error = "";
  let conversationNotice = "";
  let contextNotice = "";
  let alive = true;
  let persistedInAction = false;
  reloadBlocker = () => !alive ? undefined : busy || storagePending ? "reply"
    : drafts.size ? "draft" : undefined;

  // IndexedDB serializes the entire read/merge/write across documents, including
  // WebKit without Web Locks. No async work is performed while a transaction is live.
  const storageTransaction = async (action: () => void, initial = false): Promise<boolean> => {
    if (!alive || (storagePending && !initial)) return false;
    storagePending = true;
    main.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
      'button:not([data-action="stop"]), textarea',
    ).forEach(control => { control.disabled = true; });
    stateChanged();
    let executed = false;
    persistedInAction = false;
    try {
      const db = await openDatabase();
      if (!alive) return false;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("chat", "readwrite");
        const store = tx.objectStore("chat");
        tx.oncomplete = () => {
          if (persistedInAction) {
            tabConversations = undefined;
            tabTombstones = undefined;
            tabDirtyIds = undefined;
            tabBaselines = undefined;
            baselines.clear();
            conversations.forEach(item => baselines.set(item.id, transcript(item)));
            dirtyIds.clear();
            deletedIds.clear();
          }
          storageUnavailable = !!tabConversations;
          resolve();
        };
        tx.onabort = () => reject(tx.error || new Error("Chat storage transaction aborted"));
        tx.onerror = () => { /* Abort is the definitive failure signal. */ };
        const request = store.get("root");
        request.onsuccess = () => {
          if (!alive) { tx.abort(); return; }
          try {
            let root: ChatRoot;
            if (request.result === undefined) {
              // Import both backup keys in this same first transaction. An empty
              // root is an intentional snapshot and must never import again.
              const deleted = parseTombstones(localStorage.getItem(DELETED_STORAGE_KEY));
              root = { version: 1, conversations: applyTombstones(
                parseConversations(localStorage.getItem(STORAGE_KEY)), deleted), tombstones: deleted };
            } else root = normalizedRoot(request.result);
            stagedRoot = { conversations: root.conversations, tombstones: root.tombstones, unavailable: false };
            action();
            executed = true;
            store.put({ version: 1, conversations: stagedRoot.conversations,
              tombstones: stagedRoot.tombstones } satisfies ChatRoot, "root");
          } catch (cause) {
            // A synchronous put throw must abort; request success alone never
            // establishes durability (quota failures can abort after put success).
            tx.abort();
          } finally { stagedRoot = undefined; }
        };
      });
      return executed;
    } catch {
      if (executed && persistedInAction) retainFallback(conversations, tombstones, dirtyIds, baselines);
      if (alive) {
        storageUnavailable = true;
        if (!executed) error = "The browser could not read chat storage. Your action was not completed; retry when ready.";
      }
      return executed;
    } finally {
      storagePending = false;
    }
  };

  const current = () => conversations.find(item => item.id === activeId) || conversations[0];
  const preserveUnsavedBranch = (item: Conversation, stored: ReturnType<typeof readPersistent>) => {
    const latest = stored.conversations.find(saved => saved.id === item.id);
    if (stored.unavailable || !dirtyIds.has(item.id) || !latest) return item;
    const savedTranscript = transcript(latest);
    if (savedTranscript === transcript(item)) {
      baselines.set(item.id, savedTranscript); // Already saved elsewhere, no divergent work.
      return item;
    }
    if (savedTranscript === baselines.get(item.id)) return item;
    // A quota-failed local branch and a different saved branch both contain work.
    // Never let recovery replace the saved branch with the local one.
    dirtyIds.delete(item.id);
    const branch = { ...item, id: crypto.randomUUID(), messages: [...item.messages] };
    conversations.unshift(branch);
    if (activeId === item.id) activeId = branch.id;
    dirtyIds.add(branch.id);
    conversationNotice = "Another tab changed this conversation while browser storage was unavailable. Your unsaved messages are kept in a separate conversation.";
    return branch;
  };
  const persist = () => {
    const stored = readPersistent();
    for (const item of [...conversations]) preserveUnsavedBranch(item, stored);
    const merged = new Map(stored.unavailable
      ? conversations.map(item => [item.id, item] as const)
      : stored.conversations.map(item => [item.id, item] as const));
    for (const item of conversations) {
      // The initial empty conversation has no stored snapshot yet. Retain its
      // identity when switching away from an unsent draft, without persisting
      // that text or replacing an independently updated saved transcript.
      if (!dirtyIds.has(item.id) && !(drafts.has(item.id) && !merged.has(item.id))) continue;
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
    for (const id of baselines.keys()) {
      if (!conversations.some(item => item.id === id)) baselines.delete(id);
    }
    stagedRoot = { conversations, tombstones, unavailable: false };
    persistedInAction = true;
  };
  const render = (focusComposer = false) => {
    const conversation = current();
    const retryNotice = error || (!busy && conversation.messages[conversation.messages.length - 1]?.role === "user"
      ? "This question has no saved answer. You can retry it when ready." : "");
    main.innerHTML = `<section class="chat-page" aria-labelledby="chat-title">
      <aside class="chat-history" aria-label="Saved conversations">
        <div class="chat-history-heading"><span>CONVERSATIONS</span><button type="button" data-action="new" ${busy || storagePending ? "disabled" : ""}>New</button></div>
        <div class="chat-history-list">${conversations.map(item => `<button type="button" data-conversation="${esc(item.id)}" class="${item.id === activeId ? "active" : ""}" ${busy || storagePending ? "disabled" : ""}><span>${esc(item.title)}</span><small>${item.messages.length} message${item.messages.length === 1 ? "" : "s"}</small></button>`).join("")}</div>
        <button type="button" class="chat-delete" data-action="delete" ${conversation.messages.length && !busy && !storagePending ? "" : "disabled"}>Delete conversation</button>
      </aside>
      <div class="chat-workspace">
        <div class="chat-heading"><div><div class="eyebrow">READ-ONLY WIKI CHAT</div><h1 id="chat-title" tabindex="-1">Ask, then follow the evidence.</h1><p>The assistant searches and reads this wiki. It cannot change pages, and conversations stay in this browser.</p></div><span class="chat-boundary">No write tools</span></div>
        <div class="chat-messages" role="log" aria-live="polite">
          ${conversation.messages.length ? conversation.messages.map(message => `<article class="chat-message ${message.role}"><div class="chat-role">${message.role === "user" ? "You" : "Wiki assistant"}</div><p>${esc(message.content)}</p>${message.activity?.length ? `<details><summary>${message.activity.length} wiki action${message.activity.length === 1 ? "" : "s"}</summary><ul>${message.activity.map(item => `<li>${esc(item)}</li>`).join("")}</ul></details>` : ""}${message.sources?.length ? `<div class="chat-sources"><span>Sources</span>${message.sources.map(source => `<a href="${pageUrl(source.id)}">${esc(source.title)} <small>${esc(source.evidence)}</small></a>`).join("")}</div>` : ""}</article>`).join("") : `<div class="chat-empty"><span>✳</span><h2>Start with a real question.</h2><p>Try asking where a project stands, then ask a follow-up about one source.</p></div>`}
          ${busy ? `<div class="chat-thinking"><i></i>Searching and reading… <button type="button" data-action="stop">Stop reply</button></div>` : ""}
        </div>
        ${retryNotice ? `<div class="chat-error" role="alert"><span>${esc(retryNotice)}</span><button type="button" data-action="retry" ${busy || storagePending ? "disabled" : ""}>Retry</button></div>` : ""}
        ${conversationNotice ? `<div class="chat-storage-notice chat-conversation-notice" role="status">${esc(conversationNotice)}</div>` : ""}
        ${contextNotice ? `<div class="chat-storage-notice chat-context-notice" role="status">${esc(contextNotice)}</div>` : ""}
        ${storageUnavailable ? `<div class="chat-storage-notice" role="status">Browser storage is unavailable. New messages stay only in this tab until it is reloaded; previously saved conversations may remain after deletion.</div>` : ""}
        <form class="chat-composer"><label for="chat-input">Message</label><textarea id="chat-input" maxlength="4000" rows="2" placeholder="Ask this wiki…" ${busy || storagePending ? "disabled" : ""}></textarea><button class="primary" ${busy || storagePending ? "disabled" : ""}>Send →</button><small>Up to 12 recent messages are sent. ${storageUnavailable ? "Chats are session-only in this tab." : "Chats are saved only in local browser storage."}</small></form>
      </div>
    </section>`;
    main.querySelectorAll<HTMLButtonElement>("[data-conversation]").forEach(button => {
      button.onclick = async () => {
        if (busy || storagePending) return;
        const restoreFocus = document.activeElement === button;
        await storageTransaction(() => {
          activeId = button.dataset.conversation!;
          error = "";
          conversationNotice = "";
          contextNotice = "";
          persist(); // Keep the selected conversation when leaving or reloading Chat.
        });
        if (!alive) return;
        render(false);
        // The history DOM is replaced and persist can reorder it. Retain a
        // keyboard selection without taking focus from pointer-only activation.
        if (restoreFocus)
          main.querySelector<HTMLButtonElement>(".chat-history-list button.active")?.focus();
      };
    });
    main.querySelector<HTMLButtonElement>('[data-action="new"]')!.onclick = async () => {
      if (busy || storagePending) return;
      await storageTransaction(() => {
        const next = freshConversation();
        conversations.unshift(next);
        activeId = next.id;
        dirtyIds.add(next.id);
        error = "";
        conversationNotice = "";
        contextNotice = "";
        persist();
      });
      if (alive) render(true);
    };
    const deleteButton = main.querySelector<HTMLButtonElement>('[data-action="delete"]')!;
    deleteButton.onclick = async () => {
      if (busy || storagePending) return;
      const restoreFocus = document.activeElement === deleteButton;
      await storageTransaction(() => {
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
      });
      if (!alive) return;
      render(false);
      if (restoreFocus) {
        const target = current().messages.length ? ".chat-history-list button.active" : "#chat-input";
        const element = main.querySelector<HTMLElement>(target);
        element?.focus();
        // Native focus can reveal only a caret or part of the input. Keep the
        // whole restored control visible without moving an unrelated focus.
        element?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };
    const form = main.querySelector<HTMLFormElement>(".chat-composer")!;
    const composer = form.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.value = drafts.get(activeId) || "";
    composer.oninput = () => {
      if (composer.value) drafts.set(activeId, composer.value);
      else drafts.delete(activeId);
      stateChanged();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
      const content = input.value.trim();
      if (!content || busy || storagePending) return;
      const submitted = await storageTransaction(() => {
        drafts.delete(activeId);
        let item = current();
        const stored = readPersistent();
        if (stored.tombstones.some(deleted => deleted.id === item.id)) {
          item = freshConversation();
          conversations.unshift(item);
          activeId = item.id;
          conversationNotice = "The previous conversation was deleted in another tab. Your message started a new conversation.";
        }
        const latest = stored.conversations.find(saved => saved.id === item.id);
        if (!stored.unavailable && !dirtyIds.has(item.id) && latest && transcript(latest) !== transcript(item)) {
          conversations = conversations.map(saved => saved.id === item.id ? latest : saved);
          item = latest;
          conversationNotice = "This conversation was updated in another tab. Your message follows the latest saved messages.";
        }
        if (!stored.unavailable && !dirtyIds.has(item.id) && latest)
          baselines.set(item.id, transcript(latest));
        item = preserveUnsavedBranch(item, stored);
        item.messages.push({ role: "user", content });
        item.messages = item.messages.slice(-MAX_MESSAGES);
        item.title = item.messages.filter(message => message.role === "user")[0]?.content.slice(0, 54) || "New conversation";
        item.updated = Math.max(Date.now(), item.updated + 1);
        dirtyIds.add(item.id);
        error = "";
        persist();
      });
      if (!alive) return;
      if (submitted) void requestAnswer();
      else render(true);
    };
    const retry = main.querySelector<HTMLButtonElement>('[data-action="retry"]');
    if (retry) retry.onclick = () => void requestAnswer();
    const stop = main.querySelector<HTMLButtonElement>('[data-action="stop"]');
    if (stop) stop.onclick = () => requestController?.abort();
    if (!busy && !storagePending && focusComposer)
      main.querySelector<HTMLTextAreaElement>("#chat-input")?.focus({ preventScroll: true });
    main.querySelector(".chat-messages")?.scrollTo({ top: 1_000_000 });
    stateChanged();
  };


  const requestAnswer = async () => {
    if (!alive || busy || storagePending) return;
    let prepared: { conversation: Conversation; requestSnapshot: string; messages: ReturnType<typeof chatContext>["messages"] } | undefined;
    const ready = await storageTransaction(() => {
      let conversation = current();
      // A retry must not send a transcript deleted while this tab was stale.
      if (readPersistent().tombstones.some(item => item.id === conversation.id)) {
        error = "";
        persist();
        return;
      }
      const unsaved = conversation;
      conversation = preserveUnsavedBranch(conversation, readPersistent());
      if (conversation !== unsaved) persist();
      const beforeRequest = readPersistent();
      const savedBeforeRequest = beforeRequest.conversations.find(item => item.id === conversation.id);
      const requestSnapshot = transcript(savedBeforeRequest);
      if (!beforeRequest.unavailable && !dirtyIds.has(conversation.id) && savedBeforeRequest &&
          transcript(savedBeforeRequest) !== transcript(conversation)) {
        conversations = conversations.map(item => item.id === conversation.id ? savedBeforeRequest : item);
        error = "";
        contextNotice = "";
        conversationNotice = "This conversation was updated in another tab. Review the latest saved messages before sending again.";
        persist();
        return;
      }
      if (!beforeRequest.unavailable && !dirtyIds.has(conversation.id))
        baselines.set(conversation.id, requestSnapshot);
      const { messages, limited } = chatContext(conversation.messages);
      contextNotice = limited
        ? "Only recent conversation text and shortened excerpts were sent for this reply. Your saved messages are unchanged."
        : "";
      prepared = { conversation, requestSnapshot, messages };
      // Guard local actions before releasing the storage preflight lock.
      busy = true;
      error = "";
    });
    if (!alive) return;
    if (!ready || !prepared) {
      render(true);
      return;
    }
    let { conversation } = prepared;
    const { requestSnapshot, messages } = prepared;
    const requestId = conversation.id;
    const controller = new AbortController();
    requestController = controller;
    render(false);
    try {
      const result = (await api("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      })) as ChatResponse;
      await storageTransaction(() => {
        if (activeId !== requestId || controller.signal.aborted) return;
        const afterRequest = readPersistent();
        const latest = afterRequest.conversations.find(item => item.id === requestId);
        // A late answer belongs to the context actually sent. Preserve both branches.
        if (!afterRequest.unavailable && !afterRequest.tombstones.some(item => item.id === requestId) &&
            transcript(latest) !== requestSnapshot) {
          dirtyIds.delete(requestId);
          conversation = { ...conversation, id: crypto.randomUUID(), messages: [...conversation.messages] };
          conversations.unshift(conversation);
          activeId = conversation.id;
          conversationNotice = "Another tab updated this conversation while the reply was pending. This reply was saved as a separate conversation; both versions are kept.";
        }
        conversation.messages.push({
          role: "assistant",
          content: result.answer,
          sources: result.sources,
          activity: result.activity,
        });
        conversation.updated = Math.max(Date.now(), conversation.updated + 1);
        dirtyIds.add(conversation.id);
        persist();
      });
    } catch (cause) {
      await storageTransaction(() => {
        if (activeId !== requestId) return;
        if (readPersistent().tombstones.some(item => item.id === requestId)) {
          persist();
          return;
        }
        error = (controller.signal.aborted ? "Reply stopped." : (cause as Error).message)
          + " Your question is still here; retry when ready.";
      });
    } finally {
      if (requestController === controller) requestController = undefined;
      if (alive) {
        busy = false;
        render(true);
      }
    }
  };

  // Announce the destination only once its storage-backed controls are usable.
  main.innerHTML = '<p class="quiet" role="status">Opening your conversations…</p>';
  void storageTransaction(() => {
    const stored = readPersistent();
    if (!tabConversations) {
      conversations = stored.conversations.length ? stored.conversations : [freshConversation()];
      tombstones = stored.tombstones;
      activeId = conversations[0].id;
      baselines.clear();
      stored.conversations.forEach(item => baselines.set(item.id, transcript(item)));
    }
  }, true).then(() => {
    if (!alive) return;
    render(false);
    onReady();
  });
  return () => {
    alive = false;
    requestController?.abort();
    stateChanged();
  };
}
