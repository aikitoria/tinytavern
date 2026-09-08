import { createSignal, type Accessor } from 'solid-js';

/** Local confirmations/pickers and routed panes share the same modal focus stack. */
export function createDialogLayers() {
  const [layers, setLayers] = createSignal<{ id: symbol; enabled: Accessor<boolean> }[]>([]);
  return {
    register(enabled: Accessor<boolean>) {
      const layer = { id: Symbol(), enabled };
      setLayers((current) => [...current, layer]);
      return {
        isTop: () => layers().findLast((item) => item.enabled()) === layer,
        dispose: () => setLayers((current) => current.filter((item) => item !== layer)),
      };
    },
  };
}
export const dialogLayers = createDialogLayers();
