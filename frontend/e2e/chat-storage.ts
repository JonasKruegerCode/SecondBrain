import type { Page } from "@playwright/test";

export type ChatRoot = { version: 1; conversations: any[]; tombstones: any[] };

/** Read through a new native connection and resolve only after transaction completion. */
export async function chatRoot(page: Page, replacement?: ChatRoot): Promise<ChatRoot> {
  return page.evaluate(replacement => new Promise<ChatRoot>((resolve, reject) => {
    const opening = indexedDB.open("secondbrain.chat.v1", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("chat");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("chat", replacement ? "readwrite" : "readonly");
      const store = tx.objectStore("chat");
      const request = replacement ? store.put(replacement, "root") : store.get("root");
      let root: ChatRoot;
      request.onsuccess = () => { root = replacement || request.result; };
      tx.oncomplete = () => { db.close(); resolve(root); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), replacement);
}

export async function seedChats(page: Page, conversations: any[], tombstones: any[] = []) {
  await chatRoot(page, { version: 1, conversations, tombstones });
}

/** A put request succeeds, then its enclosing transaction aborts before commit. */
export async function abortChatWrites(page: Page) {
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      if (this.name === "chat") request.addEventListener("success", () => {
        (window as any).chatPutSucceeded = true;
        this.transaction.abort();
      });
      return request;
    };
    window.addEventListener("synthetic-storage-ready", () => {
      IDBObjectStore.prototype.put = original;
    }, { once: true });
  });
}

export async function holdChatWriter(page: Page, publication?: ChatRoot) {
  await page.evaluate(publication => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open("secondbrain.chat.v1", 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("chat", "readwrite");
      const store = tx.objectStore("chat");
      const state = window as any;
      state.chatWriterReleased = false;
      state.chatWriterDone = new Promise<void>((done, fail) => {
        tx.oncomplete = () => { db.close(); done(); };
        tx.onabort = () => { db.close(); fail(tx.error); };
      });
      const keepAlive = () => {
        const request = store.get("root");
        request.onsuccess = () => {
          if (state.chatWriterReleased) {
            if (publication) store.put(publication, "root");
          } else keepAlive();
        };
      };
      const first = store.get("root");
      first.onsuccess = () => { keepAlive(); resolve(); };
    };
  }), publication);
}

export async function releaseChatWriter(page: Page) {
  await page.evaluate(async () => {
    (window as any).chatWriterReleased = true;
    await (window as any).chatWriterDone;
  });
}
