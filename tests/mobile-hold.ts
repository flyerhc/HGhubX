import { getHoldMenuBounds, getHoldZone, HOLD_DELAY_MS, HOLD_LOCK_DISTANCE, type HoldZone } from "../src/mobileHold";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const close = (actual: number, expected: number, message: string) => {
  assert(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);
};

/** Pure checks, invoked explicitly by a future browser fixture; importing does not run them. */
export function runMobileHoldGeometryChecks(): string[] {
  const passed: string[] = [];
  for (const [width, height, expectedSize] of [
    [320, 694, 83.2],
    [390, 844, 101.4],
    [844, 390, 101.4],
    [768, 1024, 112],
  ] as const) {
    const label = `${width}×${height}`;
    const { left, top, size } = getHoldMenuBounds(width, height);
    const right = left + size, bottom = top + size;
    const centerX = width / 2, centerY = height / 2;
    close(size, expectedSize, `${label} square side`);
    close(right - left, bottom - top, `${label} physical width equals height`);
    close((left + right) / 2, centerX, `${label} horizontally centered`);
    close((top + bottom) / 2, centerY, `${label} vertically centered`);
    assert(size >= 80 && size <= 112, `${label} square stays within touch-size limits`);
    assert(left >= 0 && top >= 0 && right <= width && bottom <= height, `${label} square fits the touch layer`);

    const zone = (x: number, y: number, expected: HoldZone, point: string) => {
      assert(getHoldZone(x, y, width, height) === expected, `${label} ${point}: expected ${expected}`);
    };
    // Every square edge and corner is inside; the next pixel outside is not a menu.
    for (const [x, y] of [
      [centerX, centerY], [left, centerY], [right, centerY],
      [centerX, top], [centerX, bottom],
      [left, top], [right, top], [left, bottom], [right, bottom],
      [left + 1, top + 1], [right - 1, bottom - 1],
    ]) zone(x, y, "menu", `square point (${x}, ${y})`);
    zone(left - 1, centerY, "slow", "one pixel left of square");
    zone(right + 1, centerY, "fast", "one pixel right of square");
    zone(centerX, top - 1, "fast", "one pixel above square");
    zone(centerX, bottom + 1, "slow", "one pixel below square");

    zone(width * 0.8, height * 0.2, "fast", "upper-right outside");
    zone(width * 0.2, height * 0.8, "slow", "lower-left outside");
    zone(width, 0, "fast", "top-right corner");
    zone(0, height, "slow", "bottom-left corner");
    zone(0, 0, "fast", "top-left diagonal endpoint is no longer menu");
    zone(width, height, "fast", "bottom-right diagonal endpoint is no longer menu");
    // The remaining diagonal belongs to fast exactly on the boundary, slow below it.
    const diagonalX = width / 8, diagonalY = height / 8;
    zone(diagonalX, diagonalY, "fast", "outer diagonal boundary");
    zone(diagonalX, diagonalY - 1, "fast", "above outer diagonal");
    zone(diagonalX, diagonalY + 1, "slow", "below outer diagonal");
    passed.push(`${label}: centered pixel-square, inclusive edges, outside regions and diagonal boundary`);
  }

  close(getHoldMenuBounds(300, 600).size, 80, "small viewport uses 80px minimum");
  close(getHoldMenuBounds(500, 900).size, 112, "large viewport uses 112px maximum");
  close(getHoldMenuBounds(40, 70).size, 40, "tiny viewport clips square to available short side");
  close(getHoldMenuBounds(70, 40).size, 40, "tiny landscape clips square to available short side");
  assert(HOLD_DELAY_MS === 380, "hold threshold stays 380ms");
  assert(HOLD_LOCK_DISTANCE === 64, "fast-region lock distance stays 64px");
  passed.push("Touch-size bounds and existing hold/lock constants");

  for (const [width, height] of [
    [0, 844], [390, 0], [0, 0], [-1, 844], [390, -1],
    [NaN, 844], [390, NaN], [Infinity, 844], [390, -Infinity],
  ]) {
    const bounds = getHoldMenuBounds(width, height);
    assert(bounds.size === 0, `invalid dimensions (${width}, ${height}) have no square area`);
    assert(Number.isFinite(bounds.left) && Number.isFinite(bounds.top), "invalid dimensions do not propagate NaN/Infinity");
    assert(getHoldZone(10, 10, width, height) === "menu", "invalid dimensions use neutral menu classification");
  }
  for (const [x, y] of [[NaN, 10], [10, NaN], [Infinity, 10], [10, -Infinity]]) {
    assert(getHoldZone(x, y, 390, 844) === "menu", "invalid pointer coordinates use neutral classification");
  }
  passed.push("Zero, negative, non-finite dimensions and non-finite pointer coordinates");
  return passed;
}
