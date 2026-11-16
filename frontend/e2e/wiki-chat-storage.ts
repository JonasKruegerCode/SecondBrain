import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __wikiChatRead: () => Promise<any[]>;
    __wikiChatWrite: (conversations: any[]) => Promise<void>;
  }
}

// Native transactions deliberately await completion, including fixture writes.
export async function installWikiChatStorage(page: Page) {
  await page.addInitScript(() => {
    const open = () => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("secondbrain.chat.v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("chat");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    window.__wikiChatRead = async () => {
      const db = await open();
      try {
        return await new Promise<any[]>((resolve, reject) => {
          const transaction = db.transaction("chat", "readonly");
          const request = transaction.objectStore("chat").get("root");
          transaction.oncomplete = () => resolve(request.result?.conversations ?? []);
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
      } finally { db.close(); }
    };
    window.__wikiChatWrite = async conversations => {
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction("chat", "readwrite");
          transaction.objectStore("chat").put({ version: 1, conversations, tombstones: [] }, "root");
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
      } finally { db.close(); }
    };
  });
}

export async function failWikiChatWrites(page: Page) {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === "chat" && this.transaction.db.name === "secondbrain.chat.v1" && key === "root")
        throw new DOMException("Synthetic unavailable storage", "QuotaExceededError");
      return put.call(this, value, key);
    };
    window.addEventListener("synthetic-storage-ready", () => { IDBObjectStore.prototype.put = put; }, { once: true });
  });
}
