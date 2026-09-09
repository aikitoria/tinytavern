import { faAnglesRight, faPaperPlane, faStop, faWrench } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { api } from '../../state/api.ts';
import {
  completeComposerDraft,
  draftCompletionActive,
  stopDraftCompletion,
} from '../../state/draftCompletion.ts';
import type { ComposerCommand } from '../../composerCommands.ts';
import { imageGenerationCommands, imageGenerationTools } from '../../images/imageGeneration.tsx';
import {
  activePath,
  applyMediaJob,
  deleteConversation,
  navigateTree,
  mediaJobsByMessage,
  selectedConversation,
  setEditRequestId,
  state,
  streamingMessage,
  toast,
} from '../../state/store.ts';
import { errorMessage } from '../../util.ts';
import DropdownSurface from '../ui/DropdownSurface.tsx';
import { CHAT_MEDIA_TOOL_LINKS, openMediaTool } from '../../media/navigation.ts';
import MobileSidebarButton from '../layout/MobileSidebarButton.tsx';

const coarsePointer = matchMedia('(pointer: coarse)').matches;

const BUILTIN_COMMANDS: ComposerCommand[] = [
  {
    name: 'char',
    params: '<name>',
    description:
      'Set the assistant speaker name for this conversation (empty resets to the character)',
    run: async (args) => {
      if (state.selectedId == null) throw new Error('no conversation selected');
      await api.patchConversation(state.selectedId, state.tree, {
        speakerName: args.trim() || null,
      });
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
      return navigateTree(() => api.deleteTail(state.selectedId!, state.tree, { count }));
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
    const sent = await navigateTree(() => api.send(id, state.tree, { content }));
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
    const job = msg ? mediaJobsByMessage().get(msg.id) : undefined;
    if (job) {
      void api
        .mediaJobAction(job, 'cancel')
        .then(applyMediaJob)
        .catch((err: unknown) => toast(errorMessage(err)));
      return;
    }
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
        <div class="composer my-3 mx-auto p-1 flex relative bg-panel items-end border border-solid border-control-line gap-chat-gap max-w-composer [&_textarea]:shadow-clear [&_textarea]:flex-1 [&_textarea]:w-auto [&_textarea]:min-w-0 [&_textarea]:max-h-50 [&_textarea]:resize-none [&_textarea]:overflow-y-hidden [&_textarea]:bg-clear [&_textarea]:border-clear [&_textarea]:leading-6 [&_input[type=search]]:shadow-clear [&_input[type=search]]:flex-1 [&_input[type=search]]:w-auto [&_input[type=search]]:min-w-0 [&_input[type=search]]:max-h-50 [&_input[type=search]]:resize-none [&_input[type=search]]:overflow-y-hidden [&_input[type=search]]:bg-clear [&_input[type=search]]:border-clear [&_input[type=search]]:leading-6 [&_textarea:focus]:outline-clear [&_input[type=search]:focus]:outline-clear [&:empty]:display-none small-touch:w-auto small-touch:max-w-none small-touch:shrink-0 small-touch:m-0 small-touch:bg-panel small-touch:border-clear small-touch:rounded-none small-touch:[&_textarea]:bg-raised small-touch:[&_input[type=search]]:bg-raised w-[calc(100%_-_var(--space-6)_-_var(--space-6))] rounded-[calc(var(--composer-button-size)_/_2_+_var(--composer-shell-inset))] [&_textarea]:rounded-[calc(var(--composer-button-size)_/_2)] [&_input[type=search]]:rounded-[calc(var(--composer-button-size)_/_2)] small-touch:p-[4px_calc(4px_+_env(safe-area-inset-right))_calc(4px_+_env(safe-area-inset-bottom))_calc(4px_+_env(safe-area-inset-left))]">
          <MobileSidebarButton />
        </div>
      }
    >
      <div class="composer my-3 mx-auto p-1 flex relative bg-panel items-end border border-solid border-control-line gap-chat-gap max-w-composer [&_textarea]:shadow-clear [&_textarea]:flex-1 [&_textarea]:w-auto [&_textarea]:min-w-0 [&_textarea]:max-h-50 [&_textarea]:resize-none [&_textarea]:overflow-y-hidden [&_textarea]:bg-clear [&_textarea]:border-clear [&_textarea]:leading-6 [&_input[type=search]]:shadow-clear [&_input[type=search]]:flex-1 [&_input[type=search]]:w-auto [&_input[type=search]]:min-w-0 [&_input[type=search]]:max-h-50 [&_input[type=search]]:resize-none [&_input[type=search]]:overflow-y-hidden [&_input[type=search]]:bg-clear [&_input[type=search]]:border-clear [&_input[type=search]]:leading-6 [&_textarea:focus]:outline-clear [&_input[type=search]:focus]:outline-clear small-touch:w-auto small-touch:max-w-none small-touch:shrink-0 small-touch:m-0 small-touch:bg-panel small-touch:border-clear small-touch:rounded-none small-touch:[&_textarea]:bg-raised small-touch:[&_input[type=search]]:bg-raised w-[calc(100%_-_var(--space-6)_-_var(--space-6))] rounded-[calc(var(--composer-button-size)_/_2_+_var(--composer-shell-inset))] [&_textarea]:rounded-[calc(var(--composer-button-size)_/_2)] [&_input[type=search]]:rounded-[calc(var(--composer-button-size)_/_2)] small-touch:p-[4px_calc(4px_+_env(safe-area-inset-right))_calc(4px_+_env(safe-area-inset-bottom))_calc(4px_+_env(safe-area-inset-left))]">
        <Show when={cmdMatches().length > 0}>
          <div class="left-0 right-0 absolute popover-surface popover-menu [&_button:hover:not(:disabled)]:bg-hover [&_button.active]:bg-hover [&_button.highlighted:not([aria-selected=true])]:bg-hover [&_button[aria-selected=true]]:bg-raised [&_button[aria-checked=true]]:bg-raised small-touch:left-2 small-touch:right-2 bottom-[calc(100%_+_8px)]">
            <For each={cmdMatches()}>
              {(cmd, i) => (
                <button
                  class="items-baseline small-touch:flex-wrap small-touch:gap-y-0.5 small-touch:py-2 small-touch:px-3"
                  classList={{ active: i() === selIdx() }}
                  onClick={() => complete(cmd)}
                >
                  <span class="text-accent font-code font-semibold">/{cmd.name}</span>
                  <span class="text-dim font-code text-sm">{cmd.params}</span>
                  <span class="truncate text-dim text-caption small-touch:w-full small-touch:whitespace-normal small-touch:overflow-visible">
                    {cmd.description}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={activeCmd()}>
          {(cmd) => (
            <div class="left-0 right-0 absolute items-baseline py-2 px-3 flex gap-2 popover-surface small-touch:left-2 small-touch:right-2 small-touch:flex-wrap small-touch:gap-y-0.5 small-touch:py-2 small-touch:px-3 bottom-[calc(100%_+_8px)]">
              <span class="text-accent font-code font-semibold">/{cmd().name}</span>
              <span class="text-dim font-code text-sm">{cmd().params}</span>
              <span class="truncate text-dim text-caption small-touch:w-full small-touch:whitespace-normal small-touch:overflow-visible">
                {cmd().description}
              </span>
            </div>
          )}
        </Show>
        <MobileSidebarButton />
        <span class="tools-wrap">
          <button
            ref={toolsButton}
            type="button"
            class="send-btn rounded-circle flex items-center justify-center p-0 shrink-0 tools-btn small-touch:text-base"
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
            class="[&_button]:whitespace-nowrap"
            role="menu"
            ariaLabel="Composer tools"
            placement="top"
            align="start"
            fitContentWidth
            keyboardNavigation
            autoFocus
          >
            <For each={CHAT_MEDIA_TOOL_LINKS}>
              {(tool) => (
                <button
                  type="button"
                  role="menuitem"
                  disabled={state.selectedId === null}
                  onClick={() => {
                    setToolsOpen(false);
                    openMediaTool(tool.operation, { conversationId: state.selectedId });
                  }}
                >
                  {tool.label}
                </button>
              )}
            </For>
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
                  class="send-btn rounded-circle flex items-center justify-center p-0 shrink-0 small-touch:text-base"
                  title="Start another image generation"
                  onClick={() => void send()}
                >
                  <FontAwesomeIcon icon={faPaperPlane} class="send-icon" />
                </button>
              </Show>
              <button
                class="send-btn rounded-circle flex items-center justify-center p-0 shrink-0 stop-btn small-touch:text-base"
                title="Stop generating"
                onClick={stop}
              >
                <FontAwesomeIcon icon={faStop} size={14} />
              </button>
            </>
          }
        >
          <Show when={text().trim() || resumable()}>
            <button
              class="send-btn rounded-circle flex items-center justify-center p-0 shrink-0 tools-btn resume-btn small-touch:text-base"
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
            class="send-btn rounded-circle flex items-center justify-center p-0 shrink-0 small-touch:text-base"
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
