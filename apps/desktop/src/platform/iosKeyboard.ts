/**
 * iPhone: the keyboard should only open when the user taps a text box.
 *
 * Many screens use `autoFocus` (or call `.focus()`) so desktop users can type
 * straight away. On a phone that throws the keyboard over half the screen the
 * moment a page or sheet opens. Rather than special-casing every field, iOS
 * ignores programmatic focus on anything that would raise the keyboard. A tap
 * still focuses natively (it doesn't go through `HTMLElement.focus`), and
 * buttons, dialogs and other non-text elements still take focus as usual.
 */

const KEYBOARDLESS_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Would focusing this element bring up the on-screen keyboard? */
export function opensKeyboard(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    return !KEYBOARDLESS_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

let installed = false;

export function suppressProgrammaticKeyboard(): void {
  if (installed) return;
  installed = true;
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (opensKeyboard(this)) return;
    focus.call(this, options);
  };
}

/**
 * iPhone: keep the app in the part of the screen the keyboard leaves free.
 *
 * WebKit doesn't resize the page for the keyboard; it slides the whole page up
 * so the text box shows, which pushes the title bar off the top and leaves the
 * tab bar floating above the keys. Instead the app's root box (`.app-root`)
 * follows the visual viewport: `--app-top` / `--app-h` pin it to the visible
 * area, and `data-keyboard="open"` on <html> lets the stylesheet put away the
 * tab bar while typing, the way iOS apps do.
 */
let following = false;

export function followKeyboard(): void {
  const vv = window.visualViewport;
  if (following || !vv) return;
  following = true;
  const root = document.documentElement;
  let frame = 0;
  const update = () => {
    frame = 0;
    // Anything much shorter than the window is the keyboard (or a pinch zoom,
    // which the app turns off). A small gap is just the URL/toolbar settling.
    const open = window.innerHeight - vv.height > 120;
    if (open) {
      root.dataset.keyboard = "open";
      root.style.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
      root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    } else {
      delete root.dataset.keyboard;
      root.style.removeProperty("--app-top");
      root.style.removeProperty("--app-h");
      // WebKit can leave the document scrolled after the keyboard goes away.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  update();
}
