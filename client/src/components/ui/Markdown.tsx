import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';
import {
  faCheck,
  faEllipsis,
  faTriangleExclamation,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { faCopy } from '@fortawesome/free-regular-svg-icons';
import DropdownSurface from './DropdownSurface.tsx';
import MediaPromptMenuItems from '../../media/MediaPromptMenuItems.tsx';

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

const CODE_ACTIONS =
  '<div class="code-actions">' +
  '<button type="button" class="icon-btn code-copy-btn" title="Copy code" aria-label="Copy code"></button>' +
  '<button type="button" class="icon-btn code-more-btn" title="More code actions" aria-label="More code actions" aria-haspopup="menu" aria-expanded="false"></button>' +
  '</div>';
const copyIconTemplates = new Map<IconDefinition, SVGSVGElement>();

// Only trusted package data becomes SVG, after sanitizing the message HTML.
function setCopyIcon(button: HTMLButtonElement, icon: IconDefinition): void {
  let template = copyIconTemplates.get(icon);
  if (!template) {
    const ns = 'http://www.w3.org/2000/svg';
    template = document.createElementNS(ns, 'svg');
    template.setAttribute('class', 'fa-icon');
    template.setAttribute('viewBox', `0 0 ${icon.icon[0]} ${icon.icon[1]}`);
    template.setAttribute('width', '15');
    template.setAttribute('height', '15');
    template.setAttribute('fill', 'currentColor');
    template.setAttribute('aria-hidden', 'true');
    template.setAttribute('focusable', 'false');
    const paths = icon.icon[4];
    for (const d of typeof paths === 'string' ? [paths] : paths) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      template.append(path);
    }
    copyIconTemplates.set(icon, template);
  }
  button.replaceChildren(template.cloneNode(true));
}

const markdownRenderer = new Renderer();
let hasCodeBlocks = false;
// Preserve marked's escaping, language classes and newline; wrap before sanitization
// to avoid reparenting DOM each frame.
markdownRenderer.code = (token) => {
  hasCodeBlocks = true;
  return `<div class="code-block-wrap">${Renderer.prototype.code.call(markdownRenderer, token).replace(/\n$/, '')}${CODE_ACTIONS}</div>\n`;
};
markdownRenderer.html = (token) => {
  // Multiline HTML survives instruction filtering; decorate after sanitizing its nesting.
  if (/<pre[\s/>]/i.test(token.text)) hasCodeBlocks = true;
  return Renderer.prototype.html.call(markdownRenderer, token);
};
markdownRenderer.image = ({ text }) =>
  `<span class="text-muted italic text-[0.9em]">${escapeHtml(text.trim() || 'Media omitted')}</span>`;

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

export default function Markdown(props: {
  content: string;
  streaming: boolean;
  conversationId?: number;
}) {
  const [html, setHtml] = createSignal('');
  const [menuAnchor, setMenuAnchor] = createSignal<HTMLButtonElement>();
  const [menuText, setMenuText] = createSignal('');
  let container: HTMLDivElement | undefined;
  let raf = 0;
  const closeMenu = () => {
    untrack(menuAnchor)?.setAttribute('aria-expanded', 'false');
    setMenuAnchor(undefined);
  };

  const decorateCodeBlocks = () => {
    container?.querySelectorAll('pre').forEach((pre) => {
      if (!pre.querySelector('code')) return;
      let wrap = pre.parentElement;
      if (!wrap?.classList.contains('code-block-wrap')) {
        wrap = document.createElement('div');
        wrap.className = 'code-block-wrap';
        pre.replaceWith(wrap);
        wrap.append(pre);
        wrap.insertAdjacentHTML('beforeend', CODE_ACTIONS);
      }
      const button = wrap.querySelector<HTMLButtonElement>(
        ':scope > .code-actions > .code-copy-btn:empty',
      );
      if (button) setCopyIcon(button, faCopy);
      const more = wrap.querySelector<HTMLButtonElement>(
        ':scope > .code-actions > .code-more-btn:empty',
      );
      if (more) setCopyIcon(more, faEllipsis);
    });
  };

  const render = () => {
    closeMenu();
    const src = hideAngleInstructions(props.streaming ? autoclose(props.content) : props.content);
    hasCodeBlocks = false;
    const parsed = marked.parse(markQuotes(src), { async: false, renderer: markdownRenderer });
    setHtml(DOMPurify.sanitize(parsed, { FORBID_TAGS: FORBIDDEN_MEDIA_TAGS }));
    if (hasCodeBlocks) queueMicrotask(decorateCodeBlocks);
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
      setCopyIcon(button, faCheck);
      button.title = 'Copied';
      button.setAttribute('aria-label', 'Code copied');
      button.classList.add('copied');
    } catch {
      setCopyIcon(button, faTriangleExclamation);
      button.title = 'Copy failed';
      button.setAttribute('aria-label', 'Copy failed');
    }
    window.setTimeout(() => {
      if (!button.isConnected) return;
      setCopyIcon(button, faCopy);
      button.title = 'Copy code';
      button.setAttribute('aria-label', 'Copy code');
      button.classList.remove('copied');
    }, 1200);
  };

  const codeAction = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('.code-more-btn');
    if (!button || !container?.contains(button)) {
      void copyCode(event);
      return;
    }
    const code = button.closest('.code-block-wrap')?.querySelector('code');
    if (!code) return;
    const wasOpen = menuAnchor() === button;
    closeMenu();
    if (!wasOpen) {
      setMenuText((code.textContent ?? '').replace(/\n$/, ''));
      button.setAttribute('aria-expanded', 'true');
      setMenuAnchor(button);
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

  return (
    <>
      <div
        class="md wrap-break-word text-prose [&>:first-child]:mt-2 [&>:last-child]:mb-2 [&_pre]:overflow-x-hidden [&_pre]:wrap-anywhere [&_pre]:text-sm [&_pre]:leading-body [&_pre]:bg-code [&_pre]:rounded-sm [&_pre]:whitespace-pre-wrap [&_pre]:p-3.5 [&_pre]:pt-3 [&_.code-block-wrap]:relative [&_.code-block-wrap]:overflow-hidden [&_.code-block-wrap]:bg-code [&_.code-block-wrap]:rounded-sm [&_.code-block-wrap_pre]:m-0 [&_.code-block-wrap_pre]:pr-18 [&_.code-block-wrap_pre]:bg-clear [&_.code-block-wrap_pre]:border-clear [&_.code-block-wrap_pre]:rounded-none [&_pre_code.hljs]:block [&_pre_code.hljs]:p-0 [&_pre_code.hljs]:overflow-visible [&_pre_code.hljs]:text-inherit [&_pre_code.hljs]:bg-clear [&_pre_code]:block [&_pre_code]:[white-space:inherit] [&_.code-actions]:absolute [&_.code-actions]:z-1 [&_.code-actions]:top-1.5 [&_.code-actions]:right-1.5 [&_.code-actions]:flex [&_.code-actions]:gap-1 [&_.code-actions_.icon-btn]:w-6 [&_.code-actions_.icon-btn]:min-w-6 [&_.code-actions_.icon-btn]:min-h-0 [&_.code-copy-btn.copied]:text-success [&_.hljs-doctag]:text-accent-hot [&_.hljs-keyword]:text-accent-hot [&_.hljs-meta_.hljs-keyword]:text-accent-hot [&_.hljs-template-tag]:text-accent-hot [&_.hljs-template-variable]:text-accent-hot [&_.hljs-type]:text-accent-hot [&_.hljs-variable.language_]:text-accent-hot [&_.hljs-title]:text-user [&_.hljs-title.class_]:text-user [&_.hljs-title.class_.inherited__]:text-user [&_.hljs-title.function_]:text-user [&_.hljs-attr]:text-accent [&_.hljs-attribute]:text-accent [&_.hljs-literal]:text-accent [&_.hljs-meta]:text-accent [&_.hljs-number]:text-accent [&_.hljs-operator]:text-accent [&_.hljs-variable]:text-accent [&_.hljs-selector-attr]:text-accent [&_.hljs-selector-class]:text-accent [&_.hljs-selector-id]:text-accent [&_.hljs-built_in]:text-accent [&_.hljs-symbol]:text-accent [&_.hljs-bullet]:text-accent [&_.hljs-regexp]:text-secondary [&_.hljs-string]:text-secondary [&_.hljs-meta_.hljs-string]:text-secondary [&_.hljs-name]:text-secondary [&_.hljs-quote]:text-secondary [&_.hljs-selector-tag]:text-secondary [&_.hljs-selector-pseudo]:text-secondary [&_.hljs-comment]:text-muted [&_.hljs-code]:text-muted [&_.hljs-formula]:text-muted [&_.hljs-subst]:text-inherit [&_.hljs-emphasis]:text-inherit [&_.hljs-strong]:text-inherit [&_.hljs-section]:text-user [&_.hljs-addition]:text-success [&_.hljs-deletion]:text-danger [&_code]:font-code [&_:not(pre)>code]:py-0 [&_:not(pre)>code]:px-1 [&_em]:text-emphasis-text [&_strong]:text-strong [&_.quoted]:text-quote [&_.quoted_em]:text-inherit [&_.quoted_strong]:text-inherit [&_blockquote]:border-l-3 [&_blockquote]:border-l-solid [&_blockquote]:border-l-accent [&_blockquote]:pl-3 [&_blockquote]:text-dim [&_table]:border-collapse [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full [&_th]:border [&_th]:border-solid [&_th]:border-line [&_th]:py-1 [&_th]:px-3 [&_td]:border [&_td]:border-solid [&_td]:border-line [&_td]:py-1 [&_td]:px-3 touch:[&_.code-actions_.icon-btn]:min-w-9 touch:[&_.code-actions_.icon-btn]:size-9 touch:[&_.code-block-wrap_pre]:pr-24 [&_p]:m-[0.6em_0] [&_.code-block-wrap]:m-[0.8em_0] [&_code]:text-[0.92em] [&_:not(pre)>code]:rounded-[4px] [&_blockquote]:m-[0.6em_0]"
        ref={container}
        innerHTML={html()}
        onClick={codeAction}
      />
      <DropdownSurface
        open={menuAnchor() !== undefined}
        anchor={menuAnchor}
        onClose={closeMenu}
        role="menu"
        ariaLabel="Code block actions"
        align="end"
        fitContentWidth
        minWidth={220}
        keyboardNavigation
        autoFocus
      >
        <MediaPromptMenuItems
          text={menuText()}
          conversationId={props.conversationId}
          onClose={closeMenu}
        />
      </DropdownSurface>
    </>
  );
}
