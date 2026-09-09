import { For, createSignal } from 'solid-js';
import { faCircleQuestion } from '@fortawesome/free-regular-svg-icons';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import DropdownSurface from '../components/ui/DropdownSurface.tsx';

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
    <span class="align-text-bottom ml-2 inline-flex relative">
      <button
        ref={trigger}
        type="button"
        class="icon-btn [&.icon-btn]:p-0 [&.icon-btn]:flex-none [&.icon-btn]:text-muted [&.icon-btn]:text-size-inherit [&.icon-btn]:w-4.5 [&.icon-btn]:min-w-4.5 [&.icon-btn]:h-4.5 [&.icon-btn:hover]:text-foreground"
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
        class="z-150 p-3 items-baseline grid gap-y-2 gap-x-3 max-w-[calc(100vw_-_16px)] grid-cols-[max-content_1fr]"
        role="dialog"
        ariaLabel="Resolution sizes"
        minWidth={360}
        gap={8}
      >
        <div class="text-foreground mb-0.5 col-span-full font-semibold text-caption">
          Resolution sizes
        </div>
        <table class="border-collapse tabular-nums w-full text-caption text-left col-span-full [&_:is(th,_td)]:py-1 [&_:is(th,_td)]:px-2 [&_td]:text-dim [&_td]:whitespace-nowrap">
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
