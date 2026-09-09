import type { MediaProgress } from '@tinytavern/shared';

interface NodeState {
  state?: string;
  value?: number;
  max?: number;
  display_node_id?: string;
}

export interface ComfyProgressData {
  node?: string | null;
  display_node?: string;
  value?: number;
  max?: number;
  nodes?: string[] | Record<string, NodeState>;
}

/** Comfy reports cached nodes separately from its cumulative execution-state snapshots. */
export class ComfyGraphProgress {
  private names = new Map<string, string>();
  private finished = new Set<string>();
  private displayIds = new Map<string, string>();
  private nodeId: string | null = null;
  private value = 0;
  private max = 0;

  constructor(graph: unknown) {
    for (const [id, node] of Object.entries(
      graph as Record<
        string,
        {
          class_type?: string;
          _meta?: { title?: string };
        }
      >,
    )) {
      this.names.set(id, node._meta?.title || node.class_type || `Node ${id}`);
    }
  }

  private selectNode(id: string | null) {
    if (id === this.nodeId) return;
    this.nodeId = id;
    this.value = 0;
    this.max = 0;
  }

  update(type: string, data: ComfyProgressData): MediaProgress | null {
    switch (type) {
      case 'execution_start':
        this.finished.clear();
        this.selectNode(null);
        break;
      case 'execution_cached':
        if (!Array.isArray(data.nodes)) return null;
        for (const id of data.nodes) {
          if (this.names.has(id)) this.finished.add(id);
        }
        break;
      case 'executing':
        if (data.node && data.display_node) this.displayIds.set(data.node, data.display_node);
        this.selectNode(data.display_node ?? data.node ?? null);
        break;
      case 'progress_state': {
        if (!data.nodes || Array.isArray(data.nodes)) return null;
        const running = Object.entries(data.nodes).filter(([, node]) => node.state === 'running');
        for (const [id, node] of Object.entries(data.nodes)) {
          if (node.display_node_id) this.displayIds.set(id, node.display_node_id);
          // An expanded child finishing does not mean its parent node has finished.
          if (node.state === 'finished' && this.names.has(id)) this.finished.add(id);
        }
        const current =
          running.find(([id, node]) => (node.display_node_id ?? id) === this.nodeId) ??
          running.at(-1);
        if (current) {
          const [id, node] = current;
          this.selectNode(node.display_node_id ?? id);
          this.setSteps(node.value, node.max);
        } else {
          this.selectNode(null);
        }
        break;
      }
      case 'progress':
        if (data.node) this.selectNode(this.displayIds.get(data.node) ?? data.node);
        this.setSteps(data.value, data.max);
        break;
      case 'execution_success':
        for (const id of this.names.keys()) this.finished.add(id);
        this.selectNode(null);
        break;
      default:
        return null;
    }
    return {
      node: this.nodeId
        ? {
            id: this.nodeId,
            name: this.names.get(this.nodeId) ?? `Node ${this.nodeId}`,
          }
        : null,
      graph: { value: this.finished.size, max: this.names.size },
      value: this.value,
      max: this.max,
    };
  }

  private setSteps(value: number | undefined, max: number | undefined) {
    if (typeof value !== 'number' || typeof max !== 'number') return;
    if (!Number.isFinite(value) || !Number.isFinite(max) || value < 0 || max <= 0) return;
    this.value = Math.min(value, max);
    this.max = max;
  }
}
