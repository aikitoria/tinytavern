import { createSignal, useContext } from 'solid-js';
import { faUpload, faDownload } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { transferData, transferDocument } from '@tinytavern/shared';
import { errorMessage } from '../../util.ts';
import { createAsyncScope } from '../../state/asyncScope.ts';
import { readPageLocation } from '../../state/pageLocation.ts';
import { SettingsDraftContext } from './SettingsDraftContext.ts';

export default function SettingsTransferButtons(props: {
  type: string;
  exportData: () => unknown | Promise<unknown>;
  importData: (data: unknown) => void | Promise<void>;
  onError: (error: string) => void;
  importLabel?: string;
  exportLabel?: string;
  disabledExport?: boolean;
  disabledImport?: boolean;
}) {
  let input!: HTMLInputElement;
  const draft = useContext(SettingsDraftContext);
  const capture = createAsyncScope(() => [
    props.type,
    readPageLocation(),
    draft?.identity?.(),
    draft?.read(),
  ]);
  const [busy, setBusy] = createSignal(false);
  const run = async (action: (current: () => boolean) => void | Promise<void>) => {
    if (busy()) return;
    const current = capture();
    setBusy(true);
    try {
      await action(current);
    } catch (error) {
      if (current()) props.onError(errorMessage(error));
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
            void run(async (current) => {
              const text = await file.text();
              if (current()) await props.importData(transferData(JSON.parse(text), props.type));
            });
        }}
      />
      <button
        type="button"
        class="icon-btn"
        title={props.importLabel ?? 'Import'}
        aria-label={props.importLabel ?? 'Import'}
        disabled={busy() || props.disabledImport}
        onClick={() => input.click()}
      >
        <FontAwesomeIcon icon={faDownload} size={16} />
      </button>
      <button
        type="button"
        class="icon-btn"
        title={props.exportLabel ?? 'Export'}
        aria-label={props.exportLabel ?? 'Export'}
        disabled={busy() || props.disabledExport}
        onClick={() => void run(exportFile)}
      >
        <FontAwesomeIcon icon={faUpload} size={16} />
      </button>
    </>
  );
}
