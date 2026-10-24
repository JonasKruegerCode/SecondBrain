"""Owned loopback ASGI fixture; no background delivery or provider wiring."""
from __future__ import annotations

import json
import os
import socket

import uvicorn

from second_brain.wiki.api import create_app
from second_brain.wiki.delivery_runtime import configured_delivery
from second_brain.wiki.index_config import configured_indexes
from second_brain.wiki.store import WikiStore


def main() -> None:
    store = WikiStore(os.environ["SECOND_BRAIN_WIKI_VAULT"])
    for page_id, markdown in {
        "delivery-page": "# Delivery page\n\nFictional harbor delivery notes. See [[linked-page]].\n",
        "linked-page": "# Linked page\n\nFictional lighthouse notes. See [[delivery-page]].\n",
    }.items():
        if store.get_page(page_id) is None:
            store.save_page(page_id, markdown, None, f"fixture-seed-{page_id}")
    indexes = configured_indexes(store)
    app = create_app(
        store.path,
        indexes=indexes,
        delivery=configured_delivery(store, indexes),
        automatic_delivery=False,
        close_indexes=True,
    )
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        print(json.dumps({"port": listener.getsockname()[1]}), flush=True)
        uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(
            sockets=[listener]
        )


if __name__ == "__main__":
    main()
