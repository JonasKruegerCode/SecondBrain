from typing import Any, Protocol

from neo4j import GraphDatabase


class GraphStore(Protocol):
    """
    Protocol defining the interface for graph database operations.
    """

    def add_node(self, label: str, properties: dict[str, Any]) -> None:
        """Add a new node to the graph."""
        ...

    def add_edge(
        self,
        source_label: str,
        source_props: dict[str, Any],
        target_label: str,
        target_props: dict[str, Any],
        edge_type: str,
        edge_props: dict[str, Any] | None = None,
    ) -> None:
        """Add a directed edge between two nodes."""
        ...

    def execute_query(
        self, query: str, parameters: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """Execute a raw Cypher query."""
        ...


class Neo4jStore:
    """
    Neo4j implementation of the GraphStore.
    """

    def __init__(self, uri: str, user: str, password: str) -> None:
        self.driver = GraphDatabase.driver(uri, auth=(user, password))

    def close(self) -> None:
        """Close the database driver."""
        self.driver.close()

    def add_node(self, label: str, properties: dict[str, Any]) -> None:
        """Add a node with given label and properties."""
        query = f"MERGE (n:{label} {{id: $id}}) SET n += $props"
        # Ensure we have an ID for MERGE
        if "id" not in properties:
            raise ValueError("Properties must contain an 'id' for idempotent MERGE.")

        with self.driver.session() as session:
            session.run(query, id=properties["id"], props=properties)

    def add_edge(
        self,
        source_label: str,
        source_props: dict[str, Any],
        target_label: str,
        target_props: dict[str, Any],
        edge_type: str,
        edge_props: dict[str, Any] | None = None,
    ) -> None:
        """Add a directed edge from source to target."""
        if "id" not in source_props or "id" not in target_props:
             raise ValueError("Source and Target properties must contain an 'id'.")

        query = (
            f"MATCH (a:{source_label} {{id: $source_id}}) "
            f"MATCH (b:{target_label} {{id: $target_id}}) "
            f"MERGE (a)-[r:{edge_type}]->(b) "
        )
        if edge_props:
            query += "SET r += $edge_props"

        with self.driver.session() as session:
            session.run(
                query,
                source_id=source_props["id"],
                target_id=target_props["id"],
                edge_props=edge_props or {},
            )

    def execute_query(
        self, query: str, parameters: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """Execute a Cypher query and return the results as a list of dicts."""
        with self.driver.session() as session:
            result = session.run(query, parameters or {})
            return [record.data() for record in result]

    # ------------------------------------------------------------------
    # Wiki-Graph API (abgeleitet aus [[wikilinks]] im Markdown-Vault)
    # ------------------------------------------------------------------

    def upsert_page_node(
        self, slug: str, title: str, page_type: str, vault_path: str
    ) -> None:
        """MERGE a WikiPage node — idempotent."""
        query = (
            "MERGE (p:WikiPage {id: $id}) "
            "SET p.title = $title, p.type = $type, p.vault_path = $vault_path"
        )
        with self.driver.session() as session:
            session.run(query, id=slug, title=title, type=page_type, vault_path=vault_path)

    def upsert_edge(self, source_slug: str, target_slug: str) -> None:
        """MERGE a LINKS_TO edge — only if both WikiPage nodes already exist."""
        query = (
            "MATCH (s:WikiPage {id: $src}) "
            "MATCH (t:WikiPage {id: $tgt}) "
            "MERGE (s)-[:LINKS_TO]->(t)"
        )
        with self.driver.session() as session:
            session.run(query, src=source_slug, tgt=target_slug)

    def get_neighbors(self, seed_slugs: list[str], hops: int = 2) -> list[str]:
        """Return slugs of all nodes within `hops` hops of any seed node."""
        query = (
            f"MATCH (s:WikiPage)-[:LINKS_TO*1..{hops}]-(n:WikiPage) "
            "WHERE s.id IN $seeds "
            "RETURN DISTINCT n.id AS id"
        )
        rows = self.execute_query(query, {"seeds": seed_slugs})
        return [r["id"] for r in rows if r.get("id")]

    def delete_page_node(self, slug: str) -> None:
        """Remove a WikiPage node and all its edges."""
        self.execute_query("MATCH (n:WikiPage {id: $id}) DETACH DELETE n", {"id": slug})

    def delete_ghost_nodes(self) -> int:
        """Delete WikiPage nodes that have no vault_path (never ingested as real pages)."""
        result = self.execute_query(
            "MATCH (n:WikiPage) WHERE n.vault_path IS NULL "
            "DETACH DELETE n RETURN count(n) AS deleted"
        )
        return result[0]["deleted"] if result else 0

    def get_all_graph(self) -> dict[str, list[dict[str, Any]]]:
        """Return all WikiPage nodes and LINKS_TO edges for the UI graph view."""
        nodes = self.execute_query(
            "MATCH (n:WikiPage) RETURN n.id AS id, n.title AS title, n.type AS type"
        )
        edges = self.execute_query(
            "MATCH (a:WikiPage)-[:LINKS_TO]->(b:WikiPage) RETURN a.id AS source, b.id AS target"
        )
        return {"nodes": nodes, "edges": edges}
