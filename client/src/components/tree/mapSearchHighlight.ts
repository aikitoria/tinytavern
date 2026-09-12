import { createEffect, onCleanup } from 'solid-js';

const HIGHLIGHT_NAME = 'map-search-text';
let sharedHighlight: Highlight | undefined;
let highlightOwners = 0;
const TEXT_SCOPES = '.msg-name, .md, .treemap-mini-snippet';

/** Paint rendered text without altering Markdown, syntax highlighting, or Solid-owned nodes. */
export function highlightMapSearch(
  root: () => HTMLElement,
  query: () => string,
  mapSearchTarget: () => { messageId: number } | null,
  active: () => boolean,
): void {
  createEffect(() => {
    const text = query().trim();
    if (!active() || !text || !globalThis.CSS?.highlights || typeof Highlight === 'undefined') return;
    const container = root();
    const highlight = (sharedHighlight ??= new Highlight());
    highlightOwners++;
    const ranges = new Set<Range>();
    const clearRanges = () => {
      for (const range of ranges) highlight.delete(range);
      ranges.clear();
    };
    const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const revealed = new WeakSet<Element>();
    let frame = 0;
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);

    const update = () => {
      frame = 0;
      clearRanges();
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
            ranges.add(range);
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
      clearRanges();
      if (--highlightOwners === 0) {
        CSS.highlights.delete(HIGHLIGHT_NAME);
        sharedHighlight = undefined;
      }
    });
  });
}
