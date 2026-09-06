import { For, Show, createSignal } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { PLUGINS } from '../../plugins/index.ts';
import { createDetailNav } from '../../util.ts';

export default function ToolsTab() {
  const pages = PLUGINS.filter((plugin) => plugin.settingsPage);
  const [selected, setSelected] = createSignal(pages[0]?.id ?? '');
  const nav = createDetailNav();
  const active = () => pages.find((plugin) => plugin.id === selected());

  return (
    <div class="master-detail" classList={{ 'detail-open': nav.detailOpen() }}>
      <div class="entity-list">
        <For each={pages}>
          {(plugin) => (
            <button
              classList={{ active: selected() === plugin.id }}
              onClick={() => {
                setSelected(plugin.id);
                nav.openDetail();
              }}
            >
              {plugin.name}
            </button>
          )}
        </For>
      </div>
      <div class="form">
        <button class="detail-back" onClick={nav.closeDetail}>
          ‹ Back to list
        </button>
        <Show when={active()}>{(plugin) => <Dynamic component={plugin().settingsPage!} />}</Show>
      </div>
    </div>
  );
}
