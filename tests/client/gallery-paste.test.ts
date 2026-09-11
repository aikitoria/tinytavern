import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('gallery paste uploads files only in the active gallery outside text editors', async () => {
  const path = '../../client/src/galleryClipboard.ts';
  const { listenForGalleryPaste } = await import(path);
  let foreground = true;
  let active = true;
  let kind: 'image' | 'video' | undefined;
  const document = new EventTarget();
  class Element {
    editable = false;
    closest() {
      return this.editable ? this : null;
    }
  }
  const dialog = {
    getAttribute: () => (foreground ? 'true' : null),
    closest: () => null,
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: document },
    HTMLElement: { configurable: true, value: Element },
  });
  const uploads: File[][] = [];
  const dispose = listenForGalleryPaste({
    active: () => active,
    dialog: () => dialog,
    kind: () => kind,
    upload: (files: File[]) => {
      uploads.push(files);
    },
  });
  const image = new File(['image'], 'clipboard.png', { type: 'image/png' });
  const video = new File(['video'], 'clip.mp4');
  const paste = (files: File[], editable = false) => {
    const event = new Event('paste', { cancelable: true });
    const target = new Element();
    target.editable = editable;
    Object.defineProperties(event, {
      clipboardData: { value: { files } },
      target: { value: target },
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    assert(!paste([image], true), 'Text fields keep their native paste');
    foreground = false;
    assert(!paste([image]), 'An overlaid dialog must not upload into the gallery');
    foreground = true;
    active = false;
    assert(!paste([image]), 'Retained inactive pages must not handle paste');
    active = true;
    assert(!paste([]), 'Plain text and URLs do not trigger uploads');
    assert.equal(uploads.length, 0);
    assert(paste([image, video]));
    assert.deepEqual(uploads, [[image, video]]);
    kind = 'video';
    assert(!paste([image]), 'Video pickers ignore images');
    assert(paste([image, video]));
    assert.deepEqual(uploads[1], [video]);
    dispose();
    assert(!paste([video]), 'Unmounting removes the clipboard listener');
  } finally {
    dispose();
  }
});
