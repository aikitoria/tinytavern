import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { Show, createSignal, createUniqueId, type JSX } from 'solid-js';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import SettingLabel from './SettingField.tsx';
import Select, { type SelectOption } from './Select.tsx';

export interface NamedCollectionToolbarHandle {
  closeRename: () => void;
}

/** Collection storage, built-in choices and deletion rules belong to the caller. */
export default function NamedCollectionToolbar(props: {
  ariaLabel: string;
  options: SelectOption[];
  selected: string;
  buttonLabel?: JSX.Element;
  hasSelection: boolean;
  name: string;
  nameLabel: string;
  defaultName?: string;
  onSelect: (value: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onFinishRename?: () => void;
  ref?: NamedCollectionToolbarHandle | ((handle: NamedCollectionToolbarHandle) => void);
  children: JSX.Element;
}) {
  const [renaming, setRenaming] = createSignal(false);
  const inputId = createUniqueId();
  let input!: HTMLInputElement;
  const closeRename = () => setRenaming(false);
  const rename = () => {
    setRenaming(true);
    queueMicrotask(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  };
  const finishRename = () => {
    props.onFinishRename?.();
    closeRename();
  };
  if (typeof props.ref === 'function') props.ref({ closeRename });
  return (
    <>
      <div class="key-row prompt-preset-toolbar">
        <Select
          ariaLabel={props.ariaLabel}
          value={props.selected}
          options={props.options}
          buttonLabel={props.buttonLabel}
          onChange={(value) => {
            closeRename();
            props.onSelect(value);
          }}
        />
        <button
          onClick={() => {
            props.onNew();
            rename();
          }}
        >
          <FontAwesomeIcon icon={faPlus} size={12} /> New
        </button>
        <Show when={props.hasSelection}>
          <button
            onClick={() => {
              props.onDuplicate();
              closeRename();
            }}
          >
            Duplicate
          </button>
          <button onClick={rename}>Rename</button>
          <button
            class="danger-btn"
            onClick={() => {
              props.onDelete();
              closeRename();
            }}
          >
            Delete
          </button>
        </Show>
        {props.children}
      </div>
      <div class="prompt-preset-rename" classList={{ hidden: !renaming() || !props.hasSelection }}>
        <SettingLabel
          for={inputId}
          changed={props.defaultName !== undefined && props.name !== props.defaultName}
          onRevert={() => {
            props.onRename(props.defaultName!);
            input.focus({ preventScroll: true });
          }}
        >
          {props.nameLabel}
        </SettingLabel>
        <div class="key-row">
          <input
            id={inputId}
            ref={input}
            value={props.name}
            onInput={(event) => props.onRename(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finishRename();
            }}
          />
          <button onClick={finishRename}>Done</button>
        </div>
      </div>
    </>
  );
}
