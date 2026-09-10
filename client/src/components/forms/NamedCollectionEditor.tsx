import { createMemo, type JSX } from 'solid-js';
import NamedCollectionToolbar, {
  type NamedCollectionToolbarHandle,
} from './NamedCollectionToolbar.tsx';
import SettingsTransferButtons from '../settings/SettingsTransferButtons.tsx';
import { uniqueCollectionName } from '../../state/collectionNames.ts';
import { collectionByName } from '../../state/collectionOrder.ts';

/** The caller commits selection and repairs domain references in the same draft update. */
export function createNamedCollection<T extends { name: string }>(options: {
  items: () => T[];
  filter?: (item: T) => boolean;
  selected: () => string;
  identify: (item: T) => string;
  commit: (items: T[], selected: string, removed?: T) => void;
  create: (source: T | undefined, name: string) => T;
  newName: string | (() => string);
  defaultLabel?: string;
  adjacentOnDelete?: boolean;
}) {
  let toolbar: NamedCollectionToolbarHandle | undefined;
  const choices = () => (options.filter ? options.items().filter(options.filter) : options.items());
  const sortedChoices = createMemo(() => collectionByName(choices()));
  const current = () => choices().find((item) => options.identify(item) === options.selected());
  const replace = (item: T) => {
    const previous = current();
    options.commit(
      previous
        ? options
            .items()
            .map((entry) => (options.identify(entry) === options.identify(previous) ? item : entry))
        : [...options.items(), item],
      options.identify(item),
    );
  };
  const patch = (changes: Partial<T>) => {
    const item = current();
    if (item) replace({ ...item, ...changes });
  };
  const add = (duplicate = false) => {
    const source = current();
    const base = typeof options.newName === 'function' ? options.newName() : options.newName;
    const name = uniqueCollectionName(
      duplicate && source ? `${source.name} (copy)` : base,
      choices(),
    );
    const item = options.create(source, name);
    options.commit([...options.items(), item], options.identify(item));
  };
  const remove = () => {
    const item = current();
    if (!item) return;
    const list = choices();
    const index = list.findIndex((entry) => options.identify(entry) === options.identify(item));
    const next = options.adjacentOnDelete ? (list[index + 1] ?? list[index - 1]) : undefined;
    options.commit(
      options.items().filter((entry) => options.identify(entry) !== options.identify(item)),
      next ? options.identify(next) : '',
      item,
    );
  };
  const Toolbar = (props: {
    ariaLabel: string;
    nameLabel: string;
    emptyLabel?: string;
    unselectedLabel?: string;
    name?: string;
    defaultName?: string;
    onRename?: (name: string) => void;
    onFinishRename?: () => void;
    children?: JSX.Element;
    transfer: {
      type: string;
      onError: (error: string) => void;
      exportData: (item: T | undefined) => unknown;
      importData: (data: unknown, previous: T | undefined) => T;
      allowDefaultExport?: boolean;
    };
  }) => {
    return (
      <NamedCollectionToolbar
        ref={(handle) => {
          toolbar = handle;
        }}
        ariaLabel={props.ariaLabel}
        selected={options.selected()}
        options={[
          ...(options.defaultLabel === undefined
            ? []
            : [{ value: '', label: options.defaultLabel }]),
          ...sortedChoices().map((item) => ({ value: options.identify(item), label: item.name })),
        ]}
        buttonLabel={
          current()?.name ?? (choices().length ? props.unselectedLabel : props.emptyLabel)
        }
        hasSelection={!!current()}
        name={props.name ?? current()?.name ?? ''}
        nameLabel={props.nameLabel}
        defaultName={props.defaultName}
        onRename={(name) => (props.onRename ? props.onRename(name) : patch({ name } as Partial<T>))}
        onFinishRename={props.onFinishRename}
        onSelect={(selected) => options.commit(options.items(), selected)}
        onNew={() => add()}
        onDuplicate={() => add(true)}
        onDelete={remove}
      >
        <SettingsTransferButtons
          type={props.transfer.type}
          onError={props.transfer.onError}
          disabledExport={!props.transfer.allowDefaultExport && !current()}
          exportData={() => props.transfer.exportData(current())}
          importData={(data) => {
            replace(props.transfer.importData(data, current()));
            toolbar?.closeRename();
          }}
        />
        {props.children}
      </NamedCollectionToolbar>
    );
  };
  return { current, choices, patch, Toolbar, closeRename: () => toolbar?.closeRename() };
}
