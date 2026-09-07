import { faAnglesRight, faPaperPlane, faStop, faWrench } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { api } from '../state/api.ts';
import {
  completeComposerDraft,
  draftCompletionActive,
  stopDraftCompletion,
} from '../state/draftCompletion.ts';
import type { ComposerCommand } from '../composerCommands.ts';
import { imageGenerationCommands, imageGenerationTools } from '../images/imageGeneration.tsx';
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
import { errorMessage } from '../util.ts';
import DropdownSurface from './DropdownSurface.tsx';
import MobileSidebarButton from './MobileSidebarButton.tsx';

const coarsePointer = matchMedia('(pointer: coarse)').matches;

const BUILTIN_COMMANDS: ComposerCommand[] = [
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
        state.tree,
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
      return navigateTree(() => api.deleteTail(state.selectedId!, count, state.tree));
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

const COMMANDS: ComposerCommand[] = [...BUILTIN_COMMANDS, ...imageGenerationCommands];

// First-match dispatch silently shadows duplicate command names.
{
  const seen = new Set<string>();
  for (const cmd of COMMANDS) {
    if (seen.has(cmd.name)) {
      console.error(`[composer] duplicate slash command /${cmd.name} — later registration is dead`);
    }
    seen.add(cmd.name);
  }
}

export default function Composer() {
  const [text, setText] = createSignal('');
  const [selIdx, setSelIdx] = createSignal(0);
  const [toolsOpen, setToolsOpen] = createSignal(false);
  let area: HTMLTextAreaElement | undefined;
  let toolsButton: HTMLButtonElement | undefined;

  onCleanup(stopDraftCompletion);

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

  const complete = (cmd: ComposerCommand) => {
    setText(`/${cmd.name} `);
    area?.focus({ preventScroll: true });
  };

  const resize = () => {
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 200)}px`;
    // Suppress single-line scrollbars caused by sub-pixel rounding.
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
        toast(`Unknown command: ${content.split(/\s/)[0]}`, 'warning');
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
    const sent = await navigateTree(() => api.send(id, content, state.tree));
    // Restore failed sends without clobbering text typed during the request.
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
    if (msg) void navigateTree(() => api.resume(msg.id, state.tree));
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
    // Outside chat, no MessageNode consumes the edit request; it would open a stale editor later.
    if (event.key === 'ArrowUp' && !text() && state.viewMode === 'chat') {
      const lastUser = [...activePath()].reverse().find((m) => m.role === 'user');
      if (lastUser) {
        event.preventDefault();
        setEditRequestId(lastUser.id);
      }
      return;
    }
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
        <span class="tools-wrap">
          <button
            ref={toolsButton}
            type="button"
            class="send-btn tools-btn"
            title="Tools"
            aria-label="Composer tools"
            aria-haspopup="menu"
            aria-expanded={toolsOpen()}
            classList={{ 'tools-btn-open': toolsOpen() }}
            onClick={() => setToolsOpen(!toolsOpen())}
          >
            <FontAwesomeIcon icon={faWrench} size={17} />
          </button>
          <DropdownSurface
            open={toolsOpen()}
            anchor={() => toolsButton}
            onClose={() => setToolsOpen(false)}
            class="tools-menu"
            role="menu"
            ariaLabel="Composer tools"
            placement="top"
            align="start"
            fitContentWidth
            keyboardNavigation
            autoFocus
          >
            <For each={imageGenerationTools()}>
              {(tool) => (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setToolsOpen(false);
                    tool.run();
                  }}
                >
                  <tool.icon /> {tool.label}
                </button>
              )}
            </For>
          </DropdownSurface>
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
                  <FontAwesomeIcon icon={faPaperPlane} class="send-icon" />
                </button>
              </Show>
              <button class="send-btn stop-btn" title="Stop generating" onClick={stop}>
                <FontAwesomeIcon icon={faStop} size={14} />
              </button>
            </>
          }
        >
          <Show when={text().trim() || resumable()}>
            <button
              class="send-btn tools-btn resume-btn"
              title={
                text().trim()
                  ? 'Continue writing this message'
                  : 'Resume last reply (assistant prefill)'
              }
              onClick={continueTextOrReply}
            >
              <FontAwesomeIcon icon={faAnglesRight} />
            </button>
          </Show>
          <button
            class="send-btn"
            title="Send"
            disabled={!text().trim()}
            onClick={() => void send()}
          >
            <FontAwesomeIcon icon={faPaperPlane} class="send-icon" />
          </button>
        </Show>
      </div>
    </Show>
  );
}
