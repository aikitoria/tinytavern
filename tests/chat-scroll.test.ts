import assert from 'node:assert/strict';
import { createChatScroll } from '../client/src/chatScroll.ts';

// Model native clamping when reparsing Markdown shrinks a message. Scroll events
// and ResizeObserver callbacks may arrive in either order around the next render.
function fixture() {
  let top = 0;
  let height = 1000;
  const element = {
    clientHeight: 200,
    get scrollHeight() {
      return height;
    },
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.max(0, Math.min(value, height - this.clientHeight));
    },
  };
  const scroll = createChatScroll(element);
  scroll.follow();
  scroll.onScroll();
  return {
    element,
    scroll,
    resize(value: number) {
      height = value;
      element.scrollTop = top;
    },
  };
}

for (const notifyBeforeFollow of [true, false]) {
  const { element, scroll, resize } = fixture();
  resize(700);
  if (notifyBeforeFollow) scroll.onScroll();
  scroll.follow();
  scroll.onScroll();
  resize(1100);
  scroll.follow();
  assert.equal(element.scrollTop, 900, 'Markdown contraction must not stop later following');
}

{
  const { element, scroll, resize } = fixture();
  // Browser anchoring can also adjust the offset away from the bottom.
  element.scrollTop = 650;
  scroll.onScroll();
  resize(1100);
  scroll.follow();
  assert.equal(element.scrollTop, 900, 'layout movement alone must not pause following');
}

{
  const { element, scroll, resize } = fixture();
  // Input intent precedes its scroll event; a queued programmatic scroll event
  // and a streaming resize between them must not swallow that intent.
  scroll.pause();
  scroll.onScroll();
  resize(1100);
  scroll.follow();
  assert.equal(element.scrollTop, 800);
  element.scrollTop = 750;
  scroll.onScroll();
  resize(1200);
  scroll.follow();
  assert.equal(element.scrollTop, 750, 'streaming must respect reading older content');

  element.scrollTop = 1000;
  scroll.onScroll();
  resize(1300);
  scroll.follow();
  assert.equal(element.scrollTop, 1100, 'scrolling down to the bottom resumes following');
}

{
  const { element, scroll, resize } = fixture();
  scroll.pause();
  element.scrollTop = 799.5;
  scroll.onScroll();
  resize(1100);
  scroll.follow();
  assert.equal(element.scrollTop, 799.5, 'fractional upward input beats bottom tolerance');

  resize(600);
  scroll.onScroll();
  resize(1000);
  scroll.follow();
  assert.equal(element.scrollTop, 400, 'a contraction must not resume paused following');

  scroll.reset();
  scroll.follow();
  assert.equal(element.scrollTop, 800, 'opening a conversation resets following');
}

console.log('chat scroll tests passed');
