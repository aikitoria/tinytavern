import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { api } from '../state/api.ts';
import {
  completeComposerDraft,
  draftCompletionActive,
  stopDraftCompletion,
} from '../state/draftCompletion.ts';
import type { PluginCommand } from '../plugins/api.ts';
import { pluginCommands, pluginTools } from '../plugins/index.ts';
import {
  activePath,
  deleteConversation,
  navigateTree,
  selectedConversation,
  setEditRequestId,
  state,
  streamingMessage,
  toast,
} from '../state/store.ts';
import { errorMessage, useDismiss } from '../util.ts';
import MobileSidebarButton from './MobileSidebarButton.tsx';

const coarsePointer = matchMedia('(pointer: coarse)').matches;

const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M3.4 20.4 20.85 12.92c.8-.35.8-1.49 0-1.84L3.4 3.6c-.66-.29-1.39.2-1.39.91L2 9.12c0 .5.37.93.87.99L16 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
  </svg>
);

const ResumeIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M5 5l7 7-7 7" />
    <path d="M13 5l7 7-7 7" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
);

const WrenchIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="17"
    height="17"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

const BUILTIN_COMMANDS: PluginCommand[] = [
  {
    name: 'char',
    params: '<name>',
    description:
      'Set the assistant speaker name for this conversation (empty resets to the character)',
    run: async (args) => {
      if (state.selectedId == null) throw new Error('no conversation selected');
      await api.patchConversation(
        state.selectedId,
        { speakerName: args.trim() || null },
        state.tree.activeLeafId,
        state.tree.mutationRevision,
      );
    },
  },
  {
    name: 'del',
    params: '<count>',
    description: 'Delete messages from the end, including their swipes and descendant branches',
    run: async (args) => {
      const count = Number(args.trim());
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error('Usage: /del <positive count>');
      }
      if (state.selectedId == null) throw new Error('no conversation selected');
      return navigateTree(() =>
        api.deleteTail(
          state.selectedId!,
          count,
          state.tree.activeLeafId,
          state.tree.mutationRevision,
        ),
      );
    },
  },
  {
    name: 'delchat',
    params: '',
    description: 'Delete the current chat',
    run: async (args) => {
      if (args.trim()) throw new Error('Usage: /delchat');
      const id = state.selectedId;
      if (id == null) throw new Error('no conversation selected');
      await deleteConversation(id);
    },
  },
];

const COMMANDS: PluginCommand[] = [...BUILTIN_COMMANDS, ...pluginCommands];

// Dispatch is first-match — a plugin reusing a name would be silently
// shadowed. Surface it loudly at startup instead.
{
  const seen = new Set<string>();
  for (const cmd of COMMANDS) {
    if (seen.has(cmd.name)) {
      console.error(`[plugins] duplicate slash command /${cmd.name} — later registration is dead`);
    }
    seen.add(cmd.name);
  }
}

export default function Composer() {
  const [text, setText] = createSignal('');
  const [selIdx, setSelIdx] = createSignal(0);
  const [toolsOpen, setToolsOpen] = createSignal(false);
  let area: HTMLTextAreaElement | undefined;
  let toolsWrap: HTMLSpanElement | undefined;

  onCleanup(stopDraftCompletion);

  useDismiss(
    () => toolsWrap,
    toolsOpen,
    () => setToolsOpen(false),
  );

  // "/cha" -> completion menu; "/char args" -> parameter hint.
  const cmdQuery = () => {
    const m = text().match(/^\/(\w*)$/);
    return m ? m[1]! : null;
  };
  const cmdMatches = () => {
    const q = cmdQuery();
    return q != null ? COMMANDS.filter((c) => c.name.startsWith(q.toLowerCase())) : [];
  };
  const activeCmd = () => {
    const m = text().match(/^\/(\w+)\s/);
    return m ? COMMANDS.find((c) => c.name === m[1]!.toLowerCase()) : undefined;
  };
  const parallelCommand = () => {
    const m = text()
      .trim()
      .match(/^\/(\w+)(?:\s|$)/);
    return m
      ? COMMANDS.find((command) => command.name === m[1]!.toLowerCase())?.allowDuringGeneration ===
          true
      : false;
  };

  createEffect(() => {
    void text();
    setSelIdx(0);
  });

  const complete = (cmd: PluginCommand) => {
    setText(`/${cmd.name} `);
    area?.focus();
  };

  const resize = () => {
    if (!area) return;
    area.style.height = 'auto';
    const style = getComputedStyle(area);
    const singleLineHeight =
      Number.parseFloat(style.lineHeight) +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom);
    const multiline = area.scrollHeight > singleLineHeight + 1;
    area.classList.toggle('composer-input-multiline', multiline);
    area.closest('.composer')?.classList.toggle('composer-multiline', multiline);
    area.style.height = `${Math.min(area.scrollHeight, 200)}px`;
    // Only scroll once the max height is actually reached; otherwise sub-pixel
    // rounding makes the browser show a scrollbar on a single line.
    area.style.overflowY = area.scrollHeight > 200 ? 'auto' : 'hidden';
  };

  const send = async () => {
    const content = text().trim();
    const id = state.selectedId;
    if (!content || id == null || state.treeNavigationPending) return;

    if (content.startsWith('/')) {
      const m = content.match(/^\/(\w+)\s*([\s\S]*)$/);
      const cmd = m ? COMMANDS.find((c) => c.name === m[1]!.toLowerCase()) : undefined;
      if (!cmd) {
        toast(`Unknown command: ${content.split(/\s/)[0]}`);
        return;
      }
      try {
        const completed = await cmd.run(m![2]!);
        if (completed === false) return;
        setText('');
        queueMicrotask(resize);
      } catch (err) {
        toast(errorMessage(err));
      }
      return;
    }

    if (streamingMessage() || draftCompletionActive()) return;
    setText('');
    queueMicrotask(resize);
    const sent = await navigateTree(() =>
      api.send(id, content, state.tree.activeLeafId, state.tree.mutationRevision),
    );
    // Restore on failure so nothing is lost — unless the user typed something
    // new during the round-trip, which must not be clobbered.
    if (!sent && !text()) {
      setText(content);
      queueMicrotask(resize); // value bindings fire no input event, so re-grow manually
    }
  };

  const stop = () => {
    if (draftCompletionActive()) {
      stopDraftCompletion();
      return;
    }
    const msg = streamingMessage();
    if (msg?.generationToken != null)
      void api.stopGeneration(msg.id, msg.generationToken).catch(() => {});
  };

  // Resume = continue the last assistant reply in place (prefill-style).
  const resumable = () => {
    const endpointId = selectedConversation()?.endpointId ?? state.settings.activeEndpointId;
    const endpoint = state.endpoints.find((candidate) => candidate.id === endpointId);
    if (endpoint?.prefillMode === 'disabled') return null;
    const path = activePath();
    const last = path[path.length - 1];
    return last &&
      last.role === 'assistant' &&
      last.status !== 'streaming' &&
      (last.content || last.reasoning)
      ? last
      : null;
  };

  const resume = () => {
    const msg = resumable();
    if (msg)
      void navigateTree(() =>
        api.resume(msg.id, state.tree.activeLeafId, state.tree.mutationRevision),
      );
  };

  const continueDraft = async () => {
    const conversationId = state.selectedId;
    const draft = text();
    if (conversationId == null || !draft.trim() || draftCompletionActive()) return;
    try {
      await completeComposerDraft({
        conversationId,
        draft,
        expectedActiveLeafId: state.tree.activeLeafId,
        expectedMutationRevision: state.tree.mutationRevision,
        onText: (next) => {
          setText(next);
          queueMicrotask(resize);
        },
      });
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const continueTextOrReply = () => {
    if (text().trim()) void continueDraft();
    else resume();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return; // IME candidate confirmation, not a command
    const matches = cmdMatches();
    if (matches.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const dir = event.key === 'ArrowDown' ? 1 : -1;
        setSelIdx((i) => (i + dir + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        const exact = matches.find((command) => command.name === cmdQuery()?.toLowerCase());
        if (event.key === 'Enter' && exact && !exact.params) {
          event.preventDefault();
          void send();
          return;
        }
        event.preventDefault();
        complete(matches[Math.min(selIdx(), matches.length - 1)]!);
        return;
      }
    }
    // ↑ in an empty composer: edit the last sent user message in place.
    // Chat view only — in trace view no MessageNode is mounted to consume the
    // request, and the stale signal would pop an editor open much later.
    if (event.key === 'ArrowUp' && !text() && state.viewMode === 'chat') {
      const lastUser = [...activePath()].reverse().find((m) => m.role === 'user');
      if (lastUser) {
        event.preventDefault();
        setEditRequestId(lastUser.id);
      }
      return;
    }
    // Desktop: Enter sends, Shift+Enter newline. Touch: Enter is newline, use the button.
    if (event.key === 'Enter' && !event.shiftKey && !coarsePointer) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <Show
      when={state.selectedId != null}
      fallback={
        <div class="composer mobile-menu-only">
          <MobileSidebarButton />
        </div>
      }
    >
      <div class="composer">
        <Show when={cmdMatches().length > 0}>
          <div class="cmd-menu popover-surface popover-menu">
            <For each={cmdMatches()}>
              {(cmd, i) => (
                <button
                  class="cmd-item"
                  classList={{ active: i() === selIdx() }}
                  onClick={() => complete(cmd)}
                >
                  <span class="cmd-name">/{cmd.name}</span>
                  <span class="cmd-params">{cmd.params}</span>
                  <span class="cmd-desc">{cmd.description}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={activeCmd()}>
          {(cmd) => (
            <div class="cmd-menu cmd-hint popover-surface">
              <span class="cmd-name">/{cmd().name}</span>
              <span class="cmd-params">{cmd().params}</span>
              <span class="cmd-desc">{cmd().description}</span>
            </div>
          )}
        </Show>
        <MobileSidebarButton />
        <span class="tools-wrap" ref={toolsWrap}>
          <button
            class="send-btn tools-btn"
            title="Tools"
            classList={{ 'tools-btn-open': toolsOpen() }}
            onClick={() => setToolsOpen(!toolsOpen())}
          >
            <WrenchIcon />
          </button>
          <Show when={toolsOpen()}>
            <div class="tools-menu popover-surface popover-menu">
              <For each={pluginTools()}>
                {(tool) => (
                  <button
                    onClick={() => {
                      setToolsOpen(false);
                      tool.run();
                    }}
                  >
                    <tool.icon /> {tool.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </span>
        <textarea
          ref={area}
          class="composer-input"
          rows="1"
          placeholder="Type a message or / for commands…"
          value={text()}
          readOnly={draftCompletionActive()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            resize();
          }}
          onKeyDown={onKeyDown}
        />
        <Show
          when={!streamingMessage() && !draftCompletionActive()}
          fallback={
            <>
              <Show when={streamingMessage() && !draftCompletionActive() && parallelCommand()}>
                <button
                  class="send-btn"
                  title="Start another image generation"
                  onClick={() => void send()}
                >
                  <SendIcon />
                </button>
              </Show>
              <button class="send-btn stop-btn" title="Stop generating" onClick={stop}>
                <StopIcon />
              </button>
            </>
          }
        >
          <Show when={text().trim() || resumable()}>
            <button
              class="send-btn resume-btn"
              title={
                text().trim()
                  ? 'Continue writing this message'
                  : 'Resume last reply (assistant prefill)'
              }
              onClick={continueTextOrReply}
            >
              <ResumeIcon />
            </button>
          </Show>
          <button
            class="send-btn"
            title="Send"
            disabled={!text().trim()}
            onClick={() => void send()}
          >
            <SendIcon />
          </button>
        </Show>
      </div>
    </Show>
  );
}
