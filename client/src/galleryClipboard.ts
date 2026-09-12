/** Listen only while the gallery owns the foreground dialog; never consume editor paste. */
export function listenForGalleryPaste(options: {
  active: () => boolean;
  dialog: () => HTMLElement | null;
  kind: () => 'image' | 'video' | undefined;
  upload: (files: File[]) => void;
}): () => void {
  const onPaste = (event: ClipboardEvent) => {
    if (!options.active() || event.defaultPrevented || !event.clipboardData) return;
    const dialog = options.dialog();
    if (!dialog || dialog.getAttribute('aria-modal') !== 'true' || dialog.closest('[hidden], [inert]')) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]'))
      return;
    const expectedKind = options.kind();
    const files = [...event.clipboardData.files].filter((file) => {
      const kind =
        file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name)
          ? 'image'
          : file.type.startsWith('video/') || /\.(mp4|webm)$/i.test(file.name)
            ? 'video'
            : null;
      return kind && (!expectedKind || kind === expectedKind);
    });
    if (!files.length) return;
    event.preventDefault();
    options.upload(files);
  };
  document.addEventListener('paste', onPaste);
  return () => document.removeEventListener('paste', onPaste);
}
