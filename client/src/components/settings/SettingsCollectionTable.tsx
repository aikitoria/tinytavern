import { For, Index, Show } from 'solid-js';
import { faArrowUp, faArrowDown, faXmark } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { moveCollectionItem } from '../../state/collectionOrder.ts';
import Select, { type SelectOption } from '../ui/Select.tsx';

interface Column<T> {
  label: string;
  value: (item: T) => string;
  onChange: (item: T, value: string) => void;
  options?: SelectOption[];
  searchPlaceholder?: string;
}

/** Ordered settings collections share editing, removal and keyboard-safe row movement. */
export default function SettingsCollectionTable<T extends { id: string; name: string }>(props: {
  items: T[];
  columns: Column<T>[];
  onRemove: (item: T) => void;
  onReorder: (items: T[]) => void;
}) {
  let table!: HTMLTableElement;
  const move = (item: T, direction: -1 | 1) => {
    props.onReorder(moveCollectionItem(props.items, item.id, direction));
    queueMicrotask(() => {
      const row = table.querySelector<HTMLElement>(`[data-setting-entry="${CSS.escape(item.id)}"]`);
      const button = row?.querySelector<HTMLButtonElement>(`[data-move="${direction}"]:not(:disabled)`);
      (button ?? row)?.focus({ preventScroll: true });
    });
  };
  return (
    <div class="overflow-x-auto">
      <table
        ref={table}
        class="settings-table w-full table-fixed"
        style={{ 'min-width': `${props.columns.length * 10 + 7}rem` }}
      >
        <colgroup>
          <For each={props.columns}>{() => <col />}</For>
          <col class="w-28" />
        </colgroup>
        <thead>
          <tr>
            <For each={props.columns}>{(column) => <th scope="col">{column.label}</th>}</For>
            <th scope="col">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <Index each={props.items}>
            {(item, index) => (
              <tr>
                <Index each={props.columns}>
                  {(column) => (
                    <td>
                      <Show
                        when={column().options}
                        fallback={
                          <input
                            class="w-full min-w-0"
                            aria-label={`${column().label} for ${item().name}`}
                            value={column().value(item())}
                            onInput={(event) => column().onChange(item(), event.currentTarget.value)}
                          />
                        }
                      >
                        <Select
                          ariaLabel={`${column().label} for ${item().name}`}
                          value={column().value(item())}
                          options={column().options!}
                          searchPlaceholder={column().searchPlaceholder}
                          onChange={(value) => column().onChange(item(), value)}
                        />
                      </Show>
                    </td>
                  )}
                </Index>
                <td>
                  <div class="flex items-center justify-end gap-1" data-setting-entry={item().id} tabIndex={-1}>
                    <button
                      class="icon-btn"
                      data-move="-1"
                      title="Move up"
                      aria-label={`Move ${item().name} up`}
                      disabled={index === 0}
                      onClick={() => move(item(), -1)}
                    >
                      <FontAwesomeIcon icon={faArrowUp} size={12} />
                    </button>
                    <button
                      class="icon-btn"
                      data-move="1"
                      title="Move down"
                      aria-label={`Move ${item().name} down`}
                      disabled={index === props.items.length - 1}
                      onClick={() => move(item(), 1)}
                    >
                      <FontAwesomeIcon icon={faArrowDown} size={12} />
                    </button>
                    <button
                      class="icon-btn"
                      title="Remove"
                      aria-label={`Remove ${item().name}`}
                      onClick={() => props.onRemove(item())}
                    >
                      <FontAwesomeIcon icon={faXmark} size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </Index>
        </tbody>
      </table>
    </div>
  );
}
