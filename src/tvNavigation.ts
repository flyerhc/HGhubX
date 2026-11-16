import { useSyncExternalStore } from "react";
import "./styles/tv-navigation.css";

type Direction = "up" | "down" | "left" | "right";
const candidates = 'button, input, textarea, select, a[href], summary, [tabindex], [contenteditable="true"]';
let tvActive = false;
const subscribers = new Set<() => void>();

export const isTvNavigationActive = () => tvActive;
const subscribe = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
export const useTvNavigation = () => useSyncExternalStore(subscribe, isTvNavigationActive, () => false);

function setTvActive(value: boolean) {
  if (tvActive === value) return;
  tvActive = value;
  if (value) document.documentElement.setAttribute("data-tv-navigation", "true");
  else document.documentElement.removeAttribute("data-tv-navigation");
  subscribers.forEach(listener => listener());
}

function directionOf(event: KeyboardEvent): Direction | null {
  switch (event.key) {
    case "ArrowUp": case "DpadUp": return "up";
    case "ArrowDown": case "DpadDown": return "down";
    case "ArrowLeft": case "DpadLeft": return "left";
    case "ArrowRight": case "DpadRight": return "right";
    default: return null;
  }
}

function available(element: HTMLElement) {
  if (!element.isConnected || element.matches(':disabled, [aria-disabled="true"]') || !element.getClientRects().length) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.inert || node.hasAttribute("inert") || node.hidden || node.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
  }
  return true;
}

function inViewport(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
}

/** A modal owns all navigation, even while focus is still on its heading. */
function scope() {
  const explicit = Array.from(document.querySelectorAll<HTMLElement>('[data-tv-active-scope="true"]')).filter(available);
  if (explicit.length) return explicit[explicit.length - 1];
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')).filter(element => available(element) && inViewport(element));
  return dialogs[dialogs.length - 1] || document.body;
}

function focusables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(candidates)).filter(element => element.tabIndex >= 0 && available(element));
}

function reveal(element: HTMLElement, root: HTMLElement) {
  // Only move scroll containers, not hidden page stacks or the browser viewport.
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const rect = element.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
      if (rect.top < box.top + 8) parent.scrollTop -= box.top + 8 - rect.top;
      else if (rect.bottom > box.bottom - 8) parent.scrollTop += rect.bottom - box.bottom + 8;
    }
    if (/(auto|scroll)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth) {
      if (rect.left < box.left + 8) parent.scrollLeft -= box.left + 8 - rect.left;
      else if (rect.right > box.right - 8) parent.scrollLeft += rect.right - box.right + 8;
    }
    if (parent === root) break;
  }
}

function focus(element: HTMLElement, root: HTMLElement) {
  element.focus({ preventScroll: true });
  reveal(element, root);
}

function scroll(element: HTMLElement, direction: Direction) {
  const vertical = direction === "up" || direction === "down";
  const style = getComputedStyle(element);
  if (!/(auto|scroll)/.test(vertical ? style.overflowY : style.overflowX)) return false;
  const position = vertical ? element.scrollTop : element.scrollLeft;
  const size = vertical ? element.clientHeight : element.clientWidth;
  const maximum = (vertical ? element.scrollHeight : element.scrollWidth) - size;
  const sign = direction === "up" || direction === "left" ? -1 : 1;
  if (maximum <= 1 || (sign < 0 ? position <= 1 : position >= maximum - 1)) return false;
  const next = Math.max(0, Math.min(maximum, position + sign * Math.max(48, size * .6)));
  if (vertical) element.scrollTop = next; else element.scrollLeft = next;
  return true;
}

function move(root: HTMLElement, direction: Direction) {
  const items = focusables(root);
  if (!items.length) return;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!active || !items.includes(active)) {
    // The agreement's scrollable text is an explicit entry point before consent.
    const entry = items.find(element => element.hasAttribute("data-tv-initial"))
      || items.find(inViewport) || items[0];
    focus(entry, root);
    return;
  }
  // A focused text region consumes arrows until its edge, then exits to controls.
  if (active.hasAttribute("data-tv-scroll") && scroll(active, direction)) return;
  const from = active.getBoundingClientRect();
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "up" || direction === "left" ? -1 : 1;
  const fromMain = horizontal ? (from.left + from.right) / 2 : (from.top + from.bottom) / 2;
  const fromCross = horizontal ? (from.top + from.bottom) / 2 : (from.left + from.right) / 2;
  let chosen: HTMLElement | undefined;
  let best = Infinity;
  for (const item of items) {
    if (item === active || active.contains(item) || item.contains(active)) continue;
    const rect = item.getBoundingClientRect();
    const main = horizontal ? (rect.left + rect.right) / 2 : (rect.top + rect.bottom) / 2;
    const cross = horizontal ? (rect.top + rect.bottom) / 2 : (rect.left + rect.right) / 2;
    const forward = (main - fromMain) * sign;
    if (forward <= 1) continue;
    const overlap = horizontal ? rect.top < from.bottom && rect.bottom > from.top : rect.left < from.right && rect.right > from.left;
    // Prefer the same row/column, then the nearest diagonal control.
    const score = forward + Math.abs(cross - fromCross) * 2 + (overlap ? 0 : 10000);
    if (score < best) { best = score; chosen = item; }
  }
  if (chosen) { focus(chosen, root); return; }
  for (let parent = active.parentElement; parent; parent = parent.parentElement) {
    if (scroll(parent, direction) || parent === root) break;
  }
}

function editing(element: HTMLElement | null) {
  if (!element) return false;
  if (element.isContentEditable || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  return element instanceof HTMLInputElement && !["checkbox", "radio", "range", "button", "submit", "reset"].includes(element.type);
}

function keepEditing(element: HTMLElement | null, direction: Direction | null) {
  if (!editing(element)) return false;
  if (!direction || direction === "left" || direction === "right") return true;
  // Up/down leaves a single-line search field; left/right still edits the caret.
  if (element instanceof HTMLInputElement) return false;
  if (element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    return direction === "up" ? start > 0 : end < element.value.length;
  }
  return true;
}

/** Install once before React mounts. Touch/mouse and desktop keyboard keep their current behavior. */
export function installTvNavigation() {
  if (!/Android/i.test(navigator.userAgent)) return () => {};
  const activate = () => setTvActive(true);
  const reset = () => setTvActive(false);
  const isConfirm = (event: KeyboardEvent) => ["Enter", "NumpadEnter", "DpadCenter", "DPAD_CENTER"].includes(event.key);
  const consume = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const down = (event: KeyboardEvent) => {
    // The ES5 startup fallback has its own navigation even if this module loaded
    // before another module failed; do not intercept that diagnostic panel.
    if (document.getElementById("hg-startup-error")) return;
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = directionOf(event);
    if (!direction && (!tvActive || !isConfirm(event))) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Let text fields and sliders retain native editing semantics. Stop Feed's
    // bubbling shortcuts without suppressing the input's default keyboard action.
    if (keepEditing(active, direction) || (active instanceof HTMLInputElement && active.type === "range" && direction && ["left", "right"].includes(direction))) {
      if (direction) event.stopPropagation();
      return;
    }
    if (direction) activate();
    consume(event);
    const root = scope();
    if (direction) { move(root, direction); return; }
    if (event.repeat) return;
    if (active && root.contains(active) && available(active) && active.tabIndex >= 0 && active.matches('button, input, a[href], summary, [role="button"], [role="checkbox"], [role="switch"]')) {
      active.click();
    } else move(root, "down");
  };
  const up = (event: KeyboardEvent) => {
    if (document.getElementById("hg-startup-error")) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (tvActive && isConfirm(event) && !editing(active)) consume(event);
  };
  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  window.addEventListener("pointerdown", reset, true);
  window.addEventListener("touchstart", reset, { capture: true, passive: true });
  return () => {
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keyup", up, true);
    window.removeEventListener("pointerdown", reset, true);
    window.removeEventListener("touchstart", reset, true);
    reset();
  };
}
