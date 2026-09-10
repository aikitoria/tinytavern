import { Show, createEffect, createMemo, createSignal, on, useContext, type JSX } from 'solid-js';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { exportSettingsSection, importSettingsSection } from '@tinytavern/shared';
import SettingsTransferButtons from './SettingsTransferButtons.tsx';
import { SettingsDraftContext } from './SettingsDraftContext.ts';
export { SettingsDraftContext, type SettingsDraft } from './SettingsDraftContext.ts';

/** Sections use the containing editor's draft and field schema, including nested forms. */
export default function SettingsSection(props: {
  title: string;
  id: string;
  fields?: readonly string[];
  class?: string;
  disclosure?: { key: unknown; hasContent: boolean };
  children: JSX.Element;
}) {
  const draft = useContext(SettingsDraftContext);
  const fields = () => props.fields ?? [];
  const unavailable = () => !draft || !fields().length;
  const collapsible = props.disclosure !== undefined;
  const [expanded, setExpanded] = createSignal(!collapsible);
  if (collapsible) {
    const key = createMemo(() => props.disclosure?.key);
    const hasContent = createMemo(() => props.disclosure?.hasContent ?? false);
    createEffect(
      on([key, hasContent], ([key, filled], previous) => {
        // Reset for a loaded draft, but keep the editor open when its last value is cleared.
        if (!previous || key !== previous[0] || filled) setExpanded(filled);
      }),
    );
  }
  return (
    <section class={`settings-section ${props.class ?? ''}`}>
      <div class="settings-section-heading">
        <h3>
          {collapsible ? (
            <button
              type="button"
              class="flex items-center gap-2 border-0 bg-clear p-0 text-inherit [font:inherit]"
              aria-expanded={expanded()}
              onClick={() => setExpanded((value) => !value)}
            >
              <FontAwesomeIcon
                icon={faChevronDown}
                size={11}
                class={expanded() ? '' : '-rotate-90'}
              />
              {props.title}
            </button>
          ) : (
            props.title
          )}
        </h3>
        <Show when={fields().length}>
          <div
            class="flex gap-1 shrink-0"
            title={unavailable() ? 'This section has no transferable settings.' : undefined}
          >
            <SettingsTransferButtons
              compact
              type={`section:${props.id}`}
              importLabel={`Import ${props.title}`}
              exportLabel={`Export ${props.title}`}
              disabledImport={unavailable()}
              disabledExport={unavailable()}
              onError={(message) => draft?.onError(message)}
              exportData={async () => {
                const paths = fields();
                return exportSettingsSection(
                  draft!.schema,
                  paths,
                  draft!.exportRead ? await draft!.exportRead(paths) : draft!.read(),
                );
              }}
              importData={(data) => {
                const next = importSettingsSection(draft!.schema, fields(), data, draft!.read());
                draft!.write(next);
                draft!.onError('');
              }}
            />
          </div>
        </Show>
      </div>
      {collapsible ? (
        <div class="form-stack" classList={{ hidden: !expanded() }}>
          {props.children}
        </div>
      ) : (
        props.children
      )}
    </section>
  );
}
