"""Deterministic navigation groups; topology is never a semantic claim."""

from __future__ import annotations

import math
from collections import deque
from typing import Any


def _order(value: str) -> bytes:
    # Match JavaScript's string comparison, including supplementary Unicode IDs.
    return value.encode("utf-16-be")


def galaxy_groups(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(nodes, key=lambda node: _order(node["id"]))
    by_id = {node["id"]: node for node in ordered}
    adjacency: dict[str, set[str]] = {key: set() for key in by_id}
    for edge in edges:
        a, b = edge["source"], edge["target"]
        if a in by_id and b in by_id and a != b:
            adjacency[a].add(b)
            adjacency[b].add(a)

    def rank(key: str) -> tuple[int, bytes]:
        return -len(adjacency[key]), _order(key)

    groups: list[dict[str, Any]] = []
    membership: set[str] = set()
    seen: set[str] = set()

    def add(core: str, members: list[str], source: str, group: str | None = None) -> None:
        members.sort(key=lambda key: (key != core, rank(key)))
        row: dict[str, Any] = {
            "id": len(groups),
            "key": f"{source}:{group if group is not None else core}",
            "core": core,
            "members": members,
            "source": source,
            "curated": source == "frontmatter",
            "isolated": source == "unlinked",
        }
        if group is not None:
            row["group"] = group
            row["label"] = by_id[core].get("galaxy", {}).get("label") or next(
                (
                    node["galaxy"]["label"]
                    for node in ordered
                    if node["id"] in members and node.get("galaxy", {}).get("label")
                ),
                group,
            )
        groups.append(row)
        membership.update(members)
        seen.update(members)

    curated: dict[str, list[str]] = {}
    for node in ordered:
        group = node.get("galaxy", {}).get("group")
        if group:
            curated.setdefault(group, []).append(node["id"])
    for group in sorted(curated, key=_order):
        members = sorted(curated[group], key=rank)
        anchors = sorted(
            (key for key in members if by_id[key].get("galaxy", {}).get("anchor")), key=rank
        )
        add(anchors[0] if anchors else members[0], members, "frontmatter", group)

    def distance(start: str) -> dict[str, int]:
        result = {start: 0}
        queue = deque([start])
        while queue:
            key = queue.popleft()
            for neighbor in adjacency[key]:
                if neighbor not in membership and neighbor not in result:
                    result[neighbor] = result[key] + 1
                    queue.append(neighbor)
        return result

    for node in ordered:
        key = node["id"]
        if key in seen:
            continue
        component = sorted(distance(key), key=rank)
        seen.update(component)
        if not adjacency[key]:
            add(key, [key], "unlinked")
            continue
        hubs = [key for key in component if len(adjacency[key]) < (len(component) - 1) * 0.8]
        seeds = [(hubs or component)[0]]
        distances = [distance(seeds[0])]
        limit = min(8, math.ceil(len(component) / 7))
        for candidate in component:
            if len(seeds) >= limit:
                break
            if all(d[candidate] >= 2 for d in distances):
                seeds.append(candidate)
                distances.append(distance(candidate))
        local: list[list[str]] = [[] for _ in seeds]
        for member in component:
            owner = min(range(len(seeds)), key=lambda i: distances[i][member])
            local[owner].append(member)
        for core, members in zip(seeds, local, strict=True):
            add(core, members, "link_topology")
    return groups
