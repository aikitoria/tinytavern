import { For, createSignal } from 'solid-js';
import { faCircleQuestion } from '@fortawesome/free-regular-svg-icons';
import FontAwesomeIcon from '../components/FontAwesomeIcon.tsx';
import DropdownSurface from '../components/DropdownSurface.tsx';

const RESOLUTIONS = [
  ['0.2', '608 x 352'],
  ['0.3', '736 x 416'],
  ['0.4', '864 x 480'],
  ['0.5', '960 x 544'],
  ['0.6', '1056 x 608'],
  ['0.7', '1152 x 640'],
  ['0.8', '1216 x 672'],
  ['0.9', '1280 x 736'],
  ['0.98', '1344 x 768'],
  ['1.0', '1376 x 768'],
  ['1.2', '1504 x 832'],
  ['1.5', '1664 x 928'],
  ['1.8', '1824 x 1024'],
  ['2.0', '1920 x 1088'],
];

export default function ResolutionHelp() {
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;

  return (
    <span class="macro-help">
      <button
        ref={trigger}
        type="button"
        class="icon-btn help-btn"
        title="Resolution sizes"
        aria-label="Resolution sizes"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <FontAwesomeIcon icon={faCircleQuestion} size={14} />
      </button>
      <DropdownSurface
        open={open()}
        anchor={() => trigger}
        focusTarget={() => trigger}
        onClose={() => setOpen(false)}
        class="help-card"
        role="dialog"
        ariaLabel="Resolution sizes"
        minWidth={360}
        gap={8}
      >
        <div class="help-title">Resolution sizes</div>
        <table class="resolution-help-table">
          <thead>
            <tr>
              <th scope="col">Megapixels</th>
              <th scope="col">Aspect</th>
              <th scope="col">Output (multiple=32)</th>
            </tr>
          </thead>
          <tbody>
            <For each={RESOLUTIONS}>
              {([megapixels, output]) => (
                <tr>
                  <td>{megapixels}</td>
                  <td>16:9</td>
                  <td>{output}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </DropdownSurface>
    </span>
  );
}
