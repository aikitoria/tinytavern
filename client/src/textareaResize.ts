/** Hand a growing prompt field to the native resize grip without flex undoing the drag. */
export function prepareTextareaResize(event: {
  button: number;
  clientX: number;
  clientY: number;
  currentTarget: {
    getBoundingClientRect(): { right: number; bottom: number; height: number };
    style: { height: string; flex: string };
  };
}) {
  if (event.button !== 0) return;
  const area = event.currentTarget;
  const bounds = area.getBoundingClientRect();
  const right = bounds.right - event.clientX;
  const bottom = bounds.bottom - event.clientY;
  if (right < 0 || right > 20 || bottom < 0 || bottom > 20) return;
  // Read once at drag start; subsequent movement stays entirely native.
  area.style.height = `${bounds.height}px`;
  area.style.flex = '0 0 auto';
}
