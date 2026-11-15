type PipVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

/** 系统画中画还开着时，页面切走也不能把这条视频暂停。 */
export function systemPipActive(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  if (document.pictureInPictureElement === video) return true;
  return (video as PipVideo).webkitPresentationMode === "picture-in-picture";
}

/**
 * 桌面走标准 Picture-in-Picture。
 * iOS 的 WKWebView 没有这个接口，Safari / artplayer 用的是 webkitSetPresentationMode。
 * 原生 HLS 能进系统小窗；hls.js 的 MSE 通常不行，调用方再退回应用内小窗。
 */
export async function trySystemPip(video: HTMLVideoElement): Promise<boolean> {
  if (document.pictureInPictureEnabled && document.pictureInPictureElement !== video) {
    try {
      await video.requestPictureInPicture();
      if (document.pictureInPictureElement === video) return true;
    } catch { /* 继续试 WebKit 的演示模式 */ }
  }
  const pip = video as PipVideo;
  if (!pip.webkitSupportsPresentationMode?.("picture-in-picture") || !pip.webkitSetPresentationMode) {
    return false;
  }
  try {
    pip.webkitSetPresentationMode("picture-in-picture");
  } catch {
    return false;
  }
  return pip.webkitPresentationMode === "picture-in-picture";
}

export async function exitSystemPip(video: HTMLVideoElement | null): Promise<void> {
  if (document.pictureInPictureElement) {
    try { await document.exitPictureInPicture(); } catch { /* ignore */ }
  }
  const pip = video as PipVideo | null;
  if (pip?.webkitPresentationMode === "picture-in-picture") {
    try { pip.webkitSetPresentationMode?.("inline"); } catch { /* ignore */ }
  }
}

let miniClock: (() => number) | null = null;

export function bindMiniClock(read: () => number) {
  miniClock = read;
  return () => {
    if (miniClock === read) miniClock = null;
  };
}

export function readMiniClock(fallback: number) {
  const value = miniClock?.();
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
