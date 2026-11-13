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
