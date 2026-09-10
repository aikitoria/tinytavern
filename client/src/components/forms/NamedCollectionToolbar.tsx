import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { Show, createSignal, createUniqueId, type JSX } from 'solid-js';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import SettingLabel from './SettingField.tsx';
import Select, { type SelectOption } from '../ui/Select.tsx';

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
      <div class="key-row flex items-center gap-2 flex-wrap [&_input]:flex-1 [&_input]:min-w-0 [&_.select-control]:flex-1 [&_.select-control]:min-w-45 [&>button:not(.select-btn)]:whitespace-nowrap [&>button:not(.select-btn)]:shrink-0 small-touch:[&_.select-control]:basis-[100%]">
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
      <div
        class="py-2 px-3 grid gap-1 grid-cols-1 [&>label]:mt-0"
        classList={{ hidden: !renaming() || !props.hasSelection }}
      >
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
        <div class="key-row flex items-center gap-2 [&_input]:flex-1 [&_input]:min-w-0 [&_.select-control]:flex-1 [&_.select-control]:min-w-0 [&>button:not(.select-btn)]:whitespace-nowrap [&>button:not(.select-btn)]:shrink-0">
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
