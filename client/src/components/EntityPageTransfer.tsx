import { Show, createSignal } from 'solid-js';
import { transferObject, transferArray, type TransferEntity } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import { errorMessage } from '../util.ts';
import { useSettingsNavigation } from './SettingsGuard.tsx';
import SettingsTransferButtons from './SettingsTransferButtons.tsx';
import Modal from './Modal.tsx';

export default function EntityPageTransfer(props: {
  type: TransferEntity;
  onError: (message: string) => void;
}) {
  const navigate = useSettingsNavigation();
  const [pending, setPending] = createSignal<{ data: string; snapshot: string }>();
  const [error, setError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const save = async () => {
    const importState = pending();
    if (!importState || saving()) return;
    setSaving(true);
    try {
      await api.importEntityPage(props.type, JSON.parse(importState.data), importState.snapshot);
      setPending(undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SettingsTransferButtons
        type={`page:${props.type}`}
        importLabel="Import all"
        exportLabel="Export all"
        onError={props.onError}
        exportData={async () => (await api.exportEntityPage(props.type)).document.data}
        importData={(data) => {
          const source = transferObject(data);
          transferArray(source.items);
          navigate(() => {
            void api
              .exportEntityPage(props.type)
              .then((current) => {
                setError('');
                setPending({ data: JSON.stringify(data, null, 2), snapshot: current.snapshot });
              })
              .catch((error) => props.onError(errorMessage(error)));
          });
        }}
      />
      <Show when={pending()}>
        <Modal
          title="Import all"
          onClose={() => {
            if (!saving()) setPending(undefined);
          }}
        >
          <div class="form">
            <p class="hint">
              Matching names update existing items. New names create items. Read-only defaults
              import as editable copies. Other items are kept.
            </p>
            <label>Import contents</label>
            <textarea
              class="mono"
              rows={16}
              value={pending()!.data}
              disabled={saving()}
              onInput={(event) =>
                setPending((value) => value && { ...value, data: event.currentTarget.value })
              }
            />
            <Show when={error()}>
              <p class="notice notice-error" role="alert">
                {error()}
              </p>
            </Show>
            <div class="form-actions">
              <button class="primary-btn" disabled={saving()} onClick={() => void save()}>
                Save import
              </button>
              <button disabled={saving()} onClick={() => setPending(undefined)}>
                Discard
              </button>
            </div>
          </div>
        </Modal>
      </Show>
    </>
  );
}
