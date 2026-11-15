import Hls from "hls.js";

/** 清晰度只许慢慢升，不许跟着带宽抖。
 *
 * Shaka SimpleAbrManager 默认 8 秒内不换档（switchInterval），
 * 升档用更严的带宽阈值，降档立刻生效，避免来回跳。
 * hls.js 1.6 没有 abrSwitchInterval。capLevelToPlayerSize 每秒量一次盒子，
 * 尺寸一变就 nextLevelSwitch 清缓冲，画面会顿一下。这里自己封顶：
 * 尺寸跨过一档才改上限，升档后 8 秒内把封顶按在当前档。
 */

const UPGRADE_GAP_MS = 8000;
const BOX_MOVE_PX = 80;

type BoxLevel = { width?: number; height?: number };

/** 最高一档不超过画面像素。盒子还没撑开时返回 -1，避免锁死在最低档。 */
export function levelCapForBox(levels: BoxLevel[], cssW: number, cssH: number, dpr: number): number {
  if (cssW < 2 || cssH < 2 || levels.length === 0) return -1;
  const scale = Math.min(Math.max(dpr, 1), 3);
  const maxW = cssW * scale;
  const maxH = cssH * scale;
  let cap = -1;
  for (let i = 0; i < levels.length; i++) {
    const w = levels[i].width || 0;
    const h = levels[i].height || 0;
    if ((w === 0 && h === 0) || (w <= maxW * 1.05 && h <= maxH * 1.05)) cap = i;
  }
  return cap < 0 ? 0 : cap;
}

export function holdLevelCeiling(hls: Hls, video: HTMLVideoElement): () => void {
  let current = -1;
  let until = 0;
  let sizeCap = -1;
  let boxW = 0;
  let boxH = 0;

  const apply = () => {
    const ceiling = sizeCap < 0 ? hls.levels.length - 1 : sizeCap;
    if (ceiling < 0) return;
    if (current >= 0 && Date.now() < until) {
      hls.autoLevelCapping = Math.min(ceiling, current);
      return;
    }
    if (sizeCap >= 0) hls.autoLevelCapping = sizeCap;
  };

  const measure = () => {
    const box = video.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    const moved = boxW === 0
      || Math.abs(box.width - boxW) >= BOX_MOVE_PX
      || Math.abs(box.height - boxH) >= BOX_MOVE_PX;
    if (moved) {
      const next = levelCapForBox(hls.levels, box.width, box.height, window.devicePixelRatio || 1);
      if (next >= 0) {
        if (sizeCap >= 0 && next > sizeCap) until = 0;
        sizeCap = next;
        boxW = box.width;
        boxH = box.height;
      }
    }
    apply();
  };

  const onSwitched = (_event: unknown, data: { level: number }) => {
    if (data.level !== current) {
      current = data.level;
      until = Date.now() + UPGRADE_GAP_MS;
    }
    apply();
  };

  hls.on(Hls.Events.LEVEL_SWITCHED, onSwitched);
  hls.on(Hls.Events.MANIFEST_PARSED, measure);
  const timer = window.setInterval(measure, 1000);

  return () => {
    window.clearInterval(timer);
    hls.off(Hls.Events.LEVEL_SWITCHED, onSwitched);
    hls.off(Hls.Events.MANIFEST_PARSED, measure);
  };
}
