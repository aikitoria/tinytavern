import { createEffect, onCleanup } from 'solid-js';
import { mapSearchTarget } from './mapSearch.ts';

const HIGHLIGHT_NAME = 'map-search-text';
const TEXT_SCOPES = '.msg-name, .md, .treemap-mini-snippet';

/** Paint rendered text without altering Markdown, syntax highlighting, or Solid-owned nodes. */
export function highlightMapSearch(root: () => HTMLElement, query: () => string): void {
  createEffect(() => {
    const text = query().trim();
    if (!text || !globalThis.CSS?.highlights || typeof Highlight === 'undefined') return;
    const container = root();
    const highlight = new Highlight();
    const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const revealed = new WeakSet<Element>();
    let frame = 0;
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);

    const update = () => {
      frame = 0;
      highlight.clear();
      for (const card of container.querySelectorAll<HTMLElement>('.treemap-search-match')) {
        let first: Range | undefined;
        for (const scope of card.querySelectorAll(TEXT_SCOPES)) {
          const nodes: { node: Text; start: number; end: number }[] = [];
          const chunks: string[] = [];
          let length = 0;
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            if (!node.length || node.parentElement?.closest('button, script, style')) continue;
            nodes.push({ node, start: length, end: length + node.length });
            chunks.push(node.data);
            length += node.length;
          }
          const content = chunks.join('');
          pattern.lastIndex = 0;
          let nodeIndex = 0;
          for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
            const end = match.index + match[0].length;
            while (nodes[nodeIndex]!.end <= match.index) nodeIndex++;
            let endIndex = nodeIndex;
            while (nodes[endIndex]!.end < end) endIndex++;
            const startNode = nodes[nodeIndex]!;
            const endNode = nodes[endIndex]!;
            const range = document.createRange();
            range.setStart(startNode.node, match.index - startNode.start);
            range.setEnd(endNode.node, end - endNode.start);
            highlight.add(range);
            first ??= range;
          }
        }

        // Reveal a hit below the card's scroll viewport once per query/presentation.
        const presentation = card.firstElementChild;
        if (first && presentation && !revealed.has(presentation)) {
          revealed.add(presentation);
          const scroller = card.querySelector<HTMLElement>('.msg-swipe');
          if (!scroller?.contains(first.startContainer)) continue;
          const box = scroller.getBoundingClientRect();
          const hit = first.getBoundingClientRect();
          const scale = scroller.offsetHeight ? box.height / scroller.offsetHeight : 0;
          if (scale && (hit.top < box.top || hit.bottom > box.bottom)) {
            scroller.scrollTop += (hit.top - box.top) / scale - 8;
          }
        }
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    schedule();
    createEffect(() => {
      const target = mapSearchTarget();
      if (!target) return;
      const card = container.querySelector(`[data-message-id="${target.messageId}"]`);
      if (card?.firstElementChild) revealed.delete(card.firstElementChild);
      schedule();
    });
    onCleanup(() => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (CSS.highlights.get(HIGHLIGHT_NAME) === highlight) CSS.highlights.delete(HIGHLIGHT_NAME);
    });
  });
}
