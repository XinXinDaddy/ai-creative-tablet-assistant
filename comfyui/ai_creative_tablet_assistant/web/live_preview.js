import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

const nodeType = "AICreativeTabletReturnImage";
const currentGraph = () => app.canvas?.graph ?? app.graph;
const cached = new Map();

function getPort(node) {
  if (node.inputs?.some(input => input.name === "port" && input.link != null)) return null;
  const port = Number(node.widgets?.find(widget => widget.name === "port")?.value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function outputKey(node, graph) {
  return graph === app.graph || !graph.id ? String(node.id) : `${graph.id}:${node.id}`;
}

function updateNodes(graph, nodes, port, images) {
  if (currentGraph() !== graph) return;
  for (const node of nodes) {
    if (graph.getNodeById(node.id) !== node || getPort(node) !== port) continue;
    const key = outputKey(node, graph);
    const old = app.nodeOutputs[key];
    const current = old?.images?.[0];
    if (!images) {
      if (current?.subfolder?.startsWith("TabletLive_")) {
        const { images: removed, ...rest } = old;
        app.nodeOutputs[key] = rest;
        graph.setDirtyCanvas(true, true);
      }
    } else if (current?.filename !== images[0].filename || current?.subfolder !== images[0].subfolder) {
      app.nodeOutputs[key] = { ...old, images };
      graph.setDirtyCanvas(true, true);
    }
  }
}

async function refreshPort(graph, port, nodes) {
  const previous = cached.get(port);
  const headers = previous?.version ? { "If-None-Match": previous.version } : {};
  const response = await api.fetchApi(`/ai-creative-tablet/preview?port=${port}`, {
    headers, cache: "no-store", signal: AbortSignal.timeout(7000)
  });
  if (response.status === 404) {
    cached.delete(port);
    updateNodes(graph, nodes, port, null);
  } else if (response.status === 304 && previous) {
    updateNodes(graph, nodes, port, previous.images);
  } else if (response.ok) {
    const { images } = await response.json();
    if (!images?.length) return;
    cached.set(port, { images, version: response.headers.get("ETag") });
    updateNodes(graph, nodes, port, images);
  }
}

async function poll() {
  try {
    if (document.hidden) return;
    const graph = currentGraph();
    const nodesByPort = new Map();
    for (const node of graph?._nodes ?? []) {
      if ((node.comfyClass ?? node.type) !== nodeType) continue;
      const port = getPort(node);
      if (port === null) continue;
      if (!nodesByPort.has(port)) nodesByPort.set(port, []);
      nodesByPort.get(port).push(node);
    }
    for (const port of cached.keys()) {
      if (!nodesByPort.has(port)) cached.delete(port);
    }
    await Promise.allSettled([...nodesByPort].map(([port, nodes]) => refreshPort(graph, port, nodes)));
  } finally {
    setTimeout(poll, 1000);
  }
}

app.registerExtension({
  name: "AICreativeTablet.LivePreview",
  setup() { setTimeout(poll, 0); },
});
