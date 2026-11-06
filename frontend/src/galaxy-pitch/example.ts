/**
 * Fictional snapshot for the Galaxy design pitch.
 * Names, links and counts describe only this fixture.
 */

export interface PitchNode {
  id: string;
  title: string;
  galaxy?: { group: string; label?: string; anchor?: boolean };
}

export interface PitchEdge {
  source: string;
  target: string;
  type: string;
  rel?: string;
}

export interface PitchCluster {
  id: number;
  key: string;
  core: string;
  members: string[];
  source: "frontmatter" | "link_topology" | "unlinked";
  curated: boolean;
  isolated: boolean;
  group?: string;
  label?: string;
}

export interface Fixture {
  nodes: PitchNode[];
  edges: PitchEdge[];
  clusters: PitchCluster[];
  byId: Map<string, PitchNode>;
  membership: Map<string, PitchCluster>;
  neighbors: Map<string, Set<string>>;
  density: boolean;
}

const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const baseNodes: PitchNode[] = [
  { id: "tide-clock", title: "Tide clock", galaxy: { group: "sky-navigation", label: "Sky & navigation", anchor: true } },
  { id: "star-compass", title: "Star compass", galaxy: { group: "sky-navigation" } },
  { id: "harbor-lights", title: "Harbor lights", galaxy: { group: "sky-navigation" } },
  { id: "moon-calendar", title: "Moon calendar", galaxy: { group: "sky-navigation" } },
  { id: "night-survey", title: "Night survey", galaxy: { group: "sky-navigation" } },
  { id: "field-notebook", title: "Field notebook", galaxy: { group: "archive-practice", label: "Archive practice", anchor: true } },
  { id: "observation-method", title: "Observation method", galaxy: { group: "archive-practice" } },
  { id: "source-slip", title: "Source slip", galaxy: { group: "archive-practice" } },
  { id: "interpretation-note", title: "Interpretation note", galaxy: { group: "archive-practice" } },
  { id: "oral-history", title: "Oral history", galaxy: { group: "archive-practice" } },
  { id: "harvest-calendar", title: "Harvest calendar", galaxy: { group: "garden-year", label: "Garden year", anchor: true } },
  { id: "seed-ledger", title: "Seed ledger", galaxy: { group: "garden-year" } },
  { id: "frost-notes", title: "Frost notes", galaxy: { group: "garden-year" } },
  { id: "festival-table", title: "Festival table", galaxy: { group: "garden-year" } },
  { id: "salt-marsh", title: "Salt marsh", galaxy: { group: "garden-year" } },
  { id: "sharpening-notes", title: "Sharpening notes" },
  { id: "workbench", title: "Workbench" },
  { id: "tool-chest", title: "Tool chest" },
  { id: "oil-cloth", title: "Oil and cloth" },
  { id: "clamp-sketch", title: "Clamp sketch" },
  { id: "loose-sketch", title: "Loose sketch" },
  { id: "unnamed-slip", title: "Unnamed slip" },
];

const baseEdges: PitchEdge[] = [
  { source: "tide-clock", target: "star-compass", type: "wikilink" },
  { source: "tide-clock", target: "moon-calendar", type: "wikilink" },
  { source: "star-compass", target: "harbor-lights", type: "wikilink" },
  { source: "moon-calendar", target: "night-survey", type: "wikilink" },
  { source: "harbor-lights", target: "night-survey", type: "wikilink", rel: "see-also" },
  { source: "field-notebook", target: "observation-method", type: "wikilink" },
  { source: "field-notebook", target: "source-slip", type: "wikilink" },
  { source: "observation-method", target: "interpretation-note", type: "wikilink" },
  { source: "source-slip", target: "oral-history", type: "wikilink" },
  { source: "interpretation-note", target: "oral-history", type: "wikilink", rel: "see-also" },
  { source: "harvest-calendar", target: "seed-ledger", type: "wikilink" },
  { source: "harvest-calendar", target: "frost-notes", type: "wikilink" },
  { source: "frost-notes", target: "festival-table", type: "wikilink" },
  { source: "seed-ledger", target: "salt-marsh", type: "wikilink" },
  { source: "festival-table", target: "salt-marsh", type: "wikilink" },
  { source: "field-notebook", target: "tide-clock", type: "wikilink", rel: "see-also" },
  { source: "moon-calendar", target: "festival-table", type: "wikilink" },
  { source: "festival-table", target: "moon-calendar", type: "wikilink", rel: "see-also" },
  { source: "source-slip", target: "seed-ledger", type: "wikilink", rel: "cites" },
  { source: "salt-marsh", target: "oral-history", type: "wikilink" },
  { source: "sharpening-notes", target: "workbench", type: "wikilink" },
  { source: "sharpening-notes", target: "tool-chest", type: "wikilink" },
  { source: "sharpening-notes", target: "oil-cloth", type: "wikilink" },
  { source: "workbench", target: "clamp-sketch", type: "wikilink" },
  { source: "workbench", target: "tide-clock", type: "wikilink" },
];

function withDensity(nodes: PitchNode[], edges: PitchEdge[]): void {
  for (let i = 1; i <= 36; i++) {
    const n = String(i).padStart(2, "0");
    const id = `example-plot-${n}`;
    nodes.push({ id, title: `Example plot ${n}`, galaxy: { group: "garden-year" } });
    if (i <= 3) edges.push({ source: "harvest-calendar", target: id, type: "wikilink" });
    if (i === 4) edges.push({ source: id, target: "seed-ledger", type: "wikilink", rel: "see-also" });
  }
}

/** Same navigation grouping as the wiki: frontmatter, then link topology, then unlinked. */
export function galaxyGroups(nodes: PitchNode[], edges: PitchEdge[]): PitchCluster[] {
  const ordered = [...nodes].sort((a, b) => compareId(a.id, b.id));
  const byId = new Map(ordered.map(node => [node.id, node]));
  const adjacency = new Map<string, Set<string>>(ordered.map(node => [node.id, new Set()]));
  for (const edge of edges) {
    if (edge.source !== edge.target && byId.has(edge.source) && byId.has(edge.target)) {
      adjacency.get(edge.source)!.add(edge.target);
      adjacency.get(edge.target)!.add(edge.source);
    }
  }
  const rank = (a: string, b: string) => adjacency.get(b)!.size - adjacency.get(a)!.size || compareId(a, b);
  const groups: PitchCluster[] = [];
  const membership = new Set<string>();
  const seen = new Set<string>();
  const add = (core: string, members: string[], source: PitchCluster["source"], group?: string) => {
    members.sort((a, b) => (a === core ? -1 : b === core ? 1 : rank(a, b)));
    const row: PitchCluster = {
      id: groups.length,
      key: `${source}:${group ?? core}`,
      core,
      members,
      source,
      curated: source === "frontmatter",
      isolated: source === "unlinked",
    };
    if (group) {
      row.group = group;
      row.label = byId.get(core)?.galaxy?.label || ordered.find(node => members.includes(node.id) && node.galaxy?.label)?.galaxy?.label || group;
    }
    groups.push(row);
    members.forEach(id => { membership.add(id); seen.add(id); });
  };
  const curated = new Map<string, string[]>();
  for (const node of ordered) {
    const group = node.galaxy?.group;
    if (group) curated.set(group, [...(curated.get(group) || []), node.id]);
  }
  for (const group of [...curated.keys()].sort(compareId)) {
    const members = curated.get(group)!.sort(rank);
    const anchors = members.filter(id => byId.get(id)?.galaxy?.anchor).sort(rank);
    add(anchors[0] || members[0], members, "frontmatter", group);
  }
  const distance = (start: string) => {
    const result = new Map([[start, 0]]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const next of adjacency.get(queue[i])!) {
        if (!membership.has(next) && !result.has(next)) {
          result.set(next, result.get(queue[i])! + 1);
          queue.push(next);
        }
      }
    }
    return result;
  };
  for (const node of ordered) {
    if (seen.has(node.id)) continue;
    const component = [...distance(node.id).keys()].sort(rank);
    if (!adjacency.get(node.id)!.size) {
      add(node.id, [node.id], "unlinked");
      continue;
    }
    const hubs = component.filter(id => adjacency.get(id)!.size < (component.length - 1) * 0.8);
    const seeds = [(hubs[0] || component[0])];
    const distances = [distance(seeds[0])];
    const limit = Math.min(8, Math.ceil(component.length / 7));
    for (const candidate of component) {
      if (seeds.length >= limit) break;
      if (distances.every(d => d.get(candidate)! >= 2)) {
        seeds.push(candidate);
        distances.push(distance(candidate));
      }
    }
    const local = seeds.map(() => [] as string[]);
    for (const member of component) {
      let owner = 0;
      for (let i = 1; i < seeds.length; i++) {
        if (distances[i].get(member)! < distances[owner].get(member)!) owner = i;
      }
      local[owner].push(member);
    }
    seeds.forEach((core, index) => add(core, local[index], "link_topology"));
  }
  return groups;
}

export function buildFixture(density: boolean): Fixture {
  const nodes = baseNodes.map(node => ({ ...node, galaxy: node.galaxy ? { ...node.galaxy } : undefined }));
  const edges = baseEdges.map(edge => ({ ...edge }));
  if (density) withDensity(nodes, edges);
  const clusters = galaxyGroups(nodes, edges);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const membership = new Map<string, PitchCluster>();
  clusters.forEach(cluster => cluster.members.forEach(id => membership.set(id, cluster)));
  const neighbors = new Map<string, Set<string>>(nodes.map(node => [node.id, new Set()]));
  for (const edge of edges) {
    if (edge.source !== edge.target && byId.has(edge.source) && byId.has(edge.target)) {
      neighbors.get(edge.source)!.add(edge.target);
      neighbors.get(edge.target)!.add(edge.source);
    }
  }
  return { nodes, edges, clusters, byId, membership, neighbors, density };
}

export function clusterTitle(cluster: PitchCluster, byId: Map<string, PitchNode>): string {
  return cluster.label || byId.get(cluster.core)?.title || cluster.core;
}

export function kindLabel(cluster: PitchCluster): string {
  if (cluster.curated) return "Curated constellation";
  if (cluster.isolated) return "Unlinked shelf";
  return "Link neighborhood";
}

export function relationLabel(edge: PitchEdge): string {
  return edge.rel || "Markdown link";
}

export function directed(fixture: Fixture, id: string, way: "out" | "in"): PitchEdge[] {
  return fixture.edges.filter(edge => (way === "out" ? edge.source : edge.target) === id && edge.source !== edge.target);
}

export function crossEdges(fixture: Fixture, a: PitchCluster, b: PitchCluster): PitchEdge[] {
  return fixture.edges.filter(edge => {
    const source = fixture.membership.get(edge.source);
    const target = fixture.membership.get(edge.target);
    if (!source || !target || source.id === target.id) return false;
    return (source.id === a.id && target.id === b.id) || (source.id === b.id && target.id === a.id);
  });
}

export function internalEdges(fixture: Fixture, cluster: PitchCluster): PitchEdge[] {
  const ids = new Set(cluster.members);
  return fixture.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target);
}

export function checkFixture(fixture: Fixture): string[] {
  const problems: string[] = [];
  const sky = fixture.clusters.find(cluster => cluster.group === "sky-navigation");
  const archive = fixture.clusters.find(cluster => cluster.group === "archive-practice");
  const garden = fixture.clusters.find(cluster => cluster.group === "garden-year");
  const topology = fixture.clusters.find(cluster => cluster.source === "link_topology");
  if (sky?.core !== "tide-clock" || !sky.curated) problems.push("sky core");
  if (archive?.core !== "field-notebook") problems.push("archive core");
  if (garden?.core !== "harvest-calendar") problems.push("garden core");
  if (topology?.core !== "sharpening-notes" || topology.curated || topology.isolated) problems.push("topology core");
  if (fixture.clusters.filter(cluster => cluster.isolated).length !== 2) problems.push("unlinked shelf");
  const loose = fixture.byId.get("loose-sketch");
  if (!loose || loose.galaxy || fixture.neighbors.get("loose-sketch")!.size) problems.push("loose sketch");
  if (!sky || !garden || crossEdges(fixture, sky, garden).length !== 2) problems.push("sky garden bridges");
  if (fixture.density) {
    const quiet = fixture.byId.get("example-plot-05");
    if (!quiet || fixture.membership.get(quiet.id)?.group !== "garden-year") problems.push("density group");
    if (fixture.neighbors.get("example-plot-05")!.size) problems.push("density should stay unlinked inside the group");
    if (garden && garden.members.length !== 41) problems.push("density size");
  }
  return problems;
}
