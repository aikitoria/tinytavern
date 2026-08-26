import { createEffect, createSignal, onCleanup } from 'solid-js';
import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';

let hljsPromise: Promise<typeof import('highlight.js')> | null = null;

// Segments that must never get quote-wrapping: fenced code (also unclosed,
// mid-stream), inline code, and raw HTML tags.
const PROTECTED_SPLIT = /(```[\s\S]*?(?:```|$)|`[^`\n]*`|<[^>\n]*>)/;
const QUOTE_RE = /"[^"\n]+"|“[^”\n]+”/g;

/** Message Markdown is untrusted model output. Media URLs must never trigger
 * browser requests; generated images use the app's dedicated image viewer. */
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

const markdownRenderer = new Renderer();
markdownRenderer.image = ({ text }) =>
  `<span class="markdown-media-omitted">${escapeHtml(text.trim() || 'Media omitted')}</span>`;

/** Angle-bracket instructions are model control text, not visible message
 * content. Strip them only outside code, and never across a line boundary, so
 * examples/snippets and ordinary multiline text remain exact. */
function hideAngleInstructions(src: string): string {
  let out = '';
  let i = 0;
  let fenceTicks = 0;

  while (i < src.length) {
    if (src[i] === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;

      // Three or more ticks open/close a fenced block. Its contents may span
      // lines and must pass through byte-for-byte.
      if (run >= 3) {
        if (fenceTicks === 0) fenceTicks = run;
        else if (run >= fenceTicks) fenceTicks = 0;
        out += src.slice(i, i + run);
        i += run;
        continue;
      }

      // Inline Markdown code uses a matching run of one or two backticks.
      // Protect the entire span, including any angle-bracket examples in it.
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

/**
 * While streaming, close any still-open markers (quotes, *, **, `) at the end
 * of the buffer so emphasis and dialogue color immediately as they stream in,
 * instead of waiting for the closing marker to arrive.
 */
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

/**
 * Wraps "quoted" spans in the markdown SOURCE so the markdown inside them
 * (e.g. "Wow, *she said*") still parses — the span passes through marked as
 * inline raw HTML while its contents keep being processed.
 */
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

  const decorateCodeBlocks = () => {
    if (!container) return;
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('code-block-wrap') || !pre.querySelector('code')) {
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'code-block-wrap';
      pre.before(wrap);
      wrap.append(pre);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn code-copy-btn';
      button.title = 'Copy code';
      button.setAttribute('aria-label', 'Copy code');
      button.textContent = '⧉';
      wrap.append(button);
    });
  };

  const render = () => {
    const src = hideAngleInstructions(props.streaming ? autoclose(props.content) : props.content);
    const parsed = marked.parse(markQuotes(src), { async: false, renderer: markdownRenderer });
    setHtml(DOMPurify.sanitize(parsed, { FORBID_TAGS: FORBIDDEN_MEDIA_TAGS }));
    queueMicrotask(decorateCodeBlocks);
  };

  const highlight = async () => {
    const blocks = container?.querySelectorAll<HTMLElement>(
      'pre code[class*="language-"]:not(.hljs, .no-highlight)',
    );
    if (!blocks?.length) return;
    // The full build is lazy-loaded only when the model explicitly labels a
    // fence. Unlabelled fences remain plain text instead of being guessed.
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
    decorateCodeBlocks();
  };

  const copyCode = async (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('.code-copy-btn');
    if (!button || !container?.contains(button)) return;
    const code = button.closest('.code-block-wrap')?.querySelector('code');
    if (!code) return;
    try {
      // Marked appends one newline to fenced code output. Remove that renderer
      // artifact without eating any additional blank lines from the source.
      await navigator.clipboard.writeText((code.textContent ?? '').replace(/\n$/, ''));
      button.textContent = '✓';
      button.title = 'Copied';
      button.setAttribute('aria-label', 'Code copied');
      button.classList.add('copied');
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = '⧉';
        button.title = 'Copy code';
        button.setAttribute('aria-label', 'Copy code');
        button.classList.remove('copied');
      }, 1200);
    } catch {
      button.textContent = '!';
      button.title = 'Copy failed';
      button.setAttribute('aria-label', 'Copy failed');
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = '⧉';
        button.title = 'Copy code';
        button.setAttribute('aria-label', 'Copy code');
      }, 1200);
    }
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
