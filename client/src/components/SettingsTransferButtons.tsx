import { createSignal } from 'solid-js';
import { transferData, transferDocument } from '@tinytavern/shared';
import { errorMessage } from '../util.ts';

export default function SettingsTransferButtons(props: {
  type: string;
  exportData: () => unknown | Promise<unknown>;
  importData: (data: unknown) => void | Promise<void>;
  onError: (error: string) => void;
  importLabel?: string;
  exportLabel?: string;
  disabledExport?: boolean;
}) {
  let input!: HTMLInputElement;
  const [busy, setBusy] = createSignal(false);
  const run = async (action: () => void | Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      props.onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const exportFile = async () => {
    const document = transferDocument(props.type, await props.exportData());
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(document, null, 2) + '\n'], { type: 'application/json' }),
    );
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `${props.type.replaceAll(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        class="hidden"
        onChange={() => {
          const file = input.files?.[0];
          input.value = '';
          if (file)
            void run(async () =>
              props.importData(transferData(JSON.parse(await file.text()), props.type)),
            );
        }}
      />
      <button disabled={busy()} onClick={() => input.click()}>
        {props.importLabel ?? 'Import'}
      </button>
      <button disabled={busy() || props.disabledExport} onClick={() => void run(exportFile)}>
        {props.exportLabel ?? 'Export'}
      </button>
    </>
  );
}
