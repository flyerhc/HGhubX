export const HOLD_DELAY_MS = 380;
export type HoldZone = "fast" | "slow" | "menu";
export type HoldMenuBounds = { left: number; top: number; size: number };
export type HoldRotation = 0 | 90;
export type HoldRect = { left: number; top: number; width: number; height: number };

/** Match the actual visible lock target, including the rotated DOM rectangle. */
export function isInsideHoldTarget(clientX: number, clientY: number, rect: HoldRect): boolean {
  return rect.width > 0 && rect.height > 0
    && clientX >= rect.left && clientX <= rect.left + rect.width
    && clientY >= rect.top && clientY <= rect.top + rect.height;
}

/** Invert the player's clockwise CSS rotation. Native landscape is already in
 * player coordinates and uses rotation=0. Use this for both gestures and guides.
 */
export function getHoldPoint(clientX: number, clientY: number, rect: HoldRect, rotation: HoldRotation = 0) {
  return rotation === 90
    ? { x: clientY - rect.top, y: rect.left + rect.width - clientX, width: rect.height, height: rect.width }
    : { x: clientX - rect.left, y: clientY - rect.top, width: rect.width, height: rect.height };
}

const dimension = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

/** CSS-pixel square shared by hit testing and the first-visit guide. */
export function getHoldMenuBounds(width: number, height: number): HoldMenuBounds {
  const w = dimension(width), h = dimension(height);
  const short = Math.min(w, h);
  const size = Math.min(short, 112, Math.max(80, short * 0.26));
  return { left: (w - size) / 2, top: (h - size) / 2, size };
}

/** x/y are in player coordinates (after getHoldPoint), including in landscape. */
export function getHoldZone(x: number, y: number, width: number, height: number): HoldZone {
  const w = dimension(width), h = dimension(height);
  if (!w || !h || !Number.isFinite(x) || !Number.isFinite(y)) return "menu";
  const { left, top, size } = getHoldMenuBounds(w, h);
  if (x >= left && x <= left + size && y >= top && y <= top + size) return "menu";
  return x / w - y / h >= 0 ? "fast" : "slow";
}
