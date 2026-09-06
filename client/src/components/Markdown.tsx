import { createEffect, createSignal, onCleanup } from 'solid-js';
import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';

let hljsPromise: Promise<typeof import('highlight.js')> | null = null;

// Exclude code (including unclosed streaming fences) and HTML tags from quote wrapping.
const PROTECTED_SPLIT = /(```[\s\S]*?(?:```|$)|`[^`\n]*`|<[^>\n]*>)/;
const QUOTE_RE = /"[^"\n]+"|“[^”\n]+”/g;

/** Untrusted Markdown must not trigger media requests; generated images use the viewer. */
const FORBIDDEN_MEDIA_TAGS = [
  'img',
  'picture',
  'source',
  'video',
  'audio',
  'track',
  'iframe',
  'object',
  'embed',
  'svg',
];

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const COPY_CODE_BUTTON =
  '<button type="button" class="icon-btn code-copy-btn" title="Copy code" aria-label="Copy code">⧉</button>';
const markdownRenderer = new Renderer();
let hasRawCodeBlocks = false;
// Preserve marked's escaping, language classes and newline; wrap before sanitization
// to avoid reparenting DOM each frame.
markdownRenderer.code = (token) =>
  `<div class="code-block-wrap">${Renderer.prototype.code.call(markdownRenderer, token).replace(/\n$/, '')}${COPY_CODE_BUTTON}</div>\n`;
markdownRenderer.html = (token) => {
  // Multiline HTML survives instruction filtering; decorate after sanitizing its nesting.
  if (/<pre[\s/>]/i.test(token.text)) hasRawCodeBlocks = true;
  return Renderer.prototype.html.call(markdownRenderer, token);
};
markdownRenderer.image = ({ text }) =>
  `<span class="markdown-media-omitted">${escapeHtml(text.trim() || 'Media omitted')}</span>`;

/** Hide angle-bracket model instructions, preserving code and multiline text. */
function hideAngleInstructions(src: string): string {
  let out = '';
  let i = 0;
  let fenceTicks = 0;

  while (i < src.length) {
    if (src[i] === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;

      // Preserve fenced contents byte-for-byte, including multiline examples.
      if (run >= 3) {
        if (fenceTicks === 0) fenceTicks = run;
        else if (run >= fenceTicks) fenceTicks = 0;
        out += src.slice(i, i + run);
        i += run;
        continue;
      }

      // Protect inline code, including angle-bracket examples.
      if (fenceTicks === 0) {
        let close = src.indexOf('`', i + run);
        while (close !== -1) {
          let closeRun = 1;
          while (src[close + closeRun] === '`') closeRun++;
          if (closeRun === run) break;
          close = src.indexOf('`', close + closeRun);
        }
        if (close !== -1) {
          out += src.slice(i, close + run);
          i = close + run;
          continue;
        }
      }
    }

    if (fenceTicks === 0 && src[i] === '<') {
      const close = src.indexOf('>', i + 1);
      const newline = src.indexOf('\n', i + 1);
      const nestedOpen = src.indexOf('<', i + 1);
      if (
        close !== -1 &&
        (newline === -1 || close < newline) &&
        (nestedOpen === -1 || close < nestedOpen)
      ) {
        i = close + 1;
        continue;
      }
    }

    out += src[i];
    i++;
  }

  return out;
}

/** Close unfinished markers so emphasis and dialogue color appear during streaming. */
function autoclose(src: string): string {
  // Inside an unclosed code fence marked already renders everything as code.
  if ((src.match(/```/g) ?? []).length % 2 === 1) return src;
  let out = src;
  let scan = src.replace(/```[\s\S]*?```/g, '');
  if ((scan.match(/`/g) ?? []).length % 2 === 1) {
    out += '`';
    scan += '`';
  }
  scan = scan.replace(/`[^`\n]*`/g, '');
  const closers: string[] = [];
  if ((scan.match(/"/g) ?? []).length % 2 === 1) closers.push('"');
  if ((scan.match(/“/g) ?? []).length > (scan.match(/”/g) ?? []).length) closers.push('”');
  const bolds = (scan.match(/\*\*/g) ?? []).length;
  const singles = (scan.replace(/\*\*/g, '').match(/\*/g) ?? []).length;
  if (singles % 2 === 1) closers.push('*');
  if (bolds % 2 === 1) closers.push('**');
  return out + closers.join('');
}

/** Wrap quotes before parsing so Markdown inside them still renders. */
function markQuotes(src: string): string {
  return src
    .split(PROTECTED_SPLIT)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(QUOTE_RE, (m) => `<span class="quoted">${m}</span>`),
    )
    .join('');
}

export default function Markdown(props: { content: string; streaming: boolean }) {
  const [html, setHtml] = createSignal('');
  let container: HTMLDivElement | undefined;
  let raf = 0;

  const decorateRawCodeBlocks = () => {
    container?.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('code-block-wrap') || !pre.querySelector('code'))
        return;
      const wrap = document.createElement('div');
      wrap.className = 'code-block-wrap';
      pre.replaceWith(wrap);
      wrap.append(pre);
      wrap.insertAdjacentHTML('beforeend', COPY_CODE_BUTTON);
    });
  };

  const render = () => {
    const src = hideAngleInstructions(props.streaming ? autoclose(props.content) : props.content);
    hasRawCodeBlocks = false;
    const parsed = marked.parse(markQuotes(src), { async: false, renderer: markdownRenderer });
    setHtml(DOMPurify.sanitize(parsed, { FORBID_TAGS: FORBIDDEN_MEDIA_TAGS }));
    if (hasRawCodeBlocks) queueMicrotask(decorateRawCodeBlocks);
  };

  const highlight = async () => {
    const blocks = container?.querySelectorAll<HTMLElement>(
      'pre code[class*="language-"]:not(.hljs, .no-highlight)',
    );
    if (!blocks?.length) return;
    // Load highlighting only for labelled fences; never guess a language.
    hljsPromise ??= import('highlight.js');
    const hljs = (await hljsPromise).default;
    blocks.forEach((block) => {
      const languageClass = [...block.classList].find((name) => name.startsWith('language-'));
      const language = languageClass?.slice('language-'.length);
      if (!language || !hljs.getLanguage(language)) {
        block.classList.add('no-highlight');
        return;
      }
      hljs.highlightElement(block);
    });
  };

  const copyCode = async (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('.code-copy-btn');
    if (!button || !container?.contains(button)) return;
    const code = button.closest('.code-block-wrap')?.querySelector('code');
    if (!code) return;
    try {
      // Remove only marked's appended newline, preserving source blank lines.
      await navigator.clipboard.writeText((code.textContent ?? '').replace(/\n$/, ''));
      button.textContent = '✓';
      button.title = 'Copied';
      button.setAttribute('aria-label', 'Code copied');
      button.classList.add('copied');
    } catch {
      button.textContent = '!';
      button.title = 'Copy failed';
      button.setAttribute('aria-label', 'Copy failed');
    }
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = '⧉';
      button.title = 'Copy code';
      button.setAttribute('aria-label', 'Copy code');
      button.classList.remove('copied');
    }, 1200);
  };

  createEffect(() => {
    void props.content; // track
    if (props.streaming) {
      // Re-parse at most once per frame while tokens stream in.
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          render();
        });
      }
    } else {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      render();
      queueMicrotask(() => void highlight());
    }
  });

  onCleanup(() => cancelAnimationFrame(raf));

  return <div class="md" ref={container} innerHTML={html()} onClick={(e) => void copyCode(e)} />;
}
