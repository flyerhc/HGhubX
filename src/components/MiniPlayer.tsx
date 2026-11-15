import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useStore, type MiniPlay } from "../store";
import { bindMiniClock } from "../pip";
import type { Episode } from "../types";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import { IClose, IExpand, IPauseF, IPlayF } from "../icons";

function nextEpisode(episodes: Episode[], ep: number): Episode | undefined {
  return episodes.filter((item) => item.ep_num > ep).sort((a, b) => a.ep_num - b.ep_num)[0];
}

/** 应用内小窗：挂在页面最上层，切标签也能接着播，一集结束后自动播下一集。 */
export default function MiniPlayer() {
  const { mini, muted, volume, replaceMini, finishMini, dismissMini, setTab, stack, setFs, toast } = useStore();
  const videoRef = useRef<VideoHandle>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef({ x: 0, y: 0, moved: 0, on: false });
  const placed = useRef(false);
  const miniRef = useRef<MiniPlay | null>(mini);
  const episodesRef = useRef<Episode[]>([]);
  const nextUrlRef = useRef<{ ep: number; url: string } | null>(null);
  const advancing = useRef(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [paused, setPaused] = useState(false);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const posRef = useRef(pos);
  posRef.current = pos;
  miniRef.current = mini;
  episodesRef.current = episodes;

  useEffect(() => {
    if (!mini) {
      setEpisodes([]);
      nextUrlRef.current = null;
      return undefined;
    }
    const videoId = mini.videoId;
    let alive = true;
    setEpisodes([]);
    api.video(videoId).then((detail) => {
      if (!alive || miniRef.current?.videoId !== videoId) return;
      setEpisodes(detail.episodes || []);
    }).catch(() => {});
    return () => { alive = false; };
  }, [mini?.videoId]);

  useEffect(() => {
    if (!mini) return undefined;
    const videoId = mini.videoId;
    const upcoming = nextEpisode(episodes, mini.ep);
    if (!upcoming) return undefined;
    let alive = true;
    api.play(videoId, upcoming.ep_num).then((info) => {
      if (!alive || !info?.video_url || miniRef.current?.videoId !== videoId || miniRef.current.ep !== mini.ep) return;
      nextUrlRef.current = { ep: upcoming.ep_num, url: info.video_url };
    }).catch(() => {});
    return () => { alive = false; };
  }, [mini?.videoId, mini?.ep, episodes]);

  useLayoutEffect(() => {
    if (!mini) {
      placed.current = false;
      return undefined;
    }
    if (!placed.current) {
      placed.current = true;
      const w = mini.landscape ? 196 : 118;
      const h = mini.landscape ? 112 : 210;
      setPos({
        x: Math.max(10, window.innerWidth - w - 12),
        y: Math.max(52, window.innerHeight - h - 108),
      });
    }
    setPaused(false);
    advancing.current = false;
    return bindMiniClock(() => videoRef.current?.el()?.currentTime ?? mini.time);
  }, [mini]);

  const playNext = async () => {
    const current = miniRef.current;
    if (!current || advancing.current) return;
    advancing.current = true;
    try {
      if (!episodesRef.current.length) {
        const detail = await api.video(current.videoId);
        if (miniRef.current?.videoId !== current.videoId) return;
        episodesRef.current = detail.episodes || [];
      }
      const upcoming = nextEpisode(episodesRef.current, current.ep);
      if (!upcoming) return;
      const cached = nextUrlRef.current?.ep === upcoming.ep_num ? nextUrlRef.current.url : "";
      const url = cached || (await api.play(current.videoId, upcoming.ep_num))?.video_url;
      if (!url || miniRef.current?.playKey !== current.playKey) return;
      nextUrlRef.current = null;
      replaceMini({
        ...current,
        ep: upcoming.ep_num,
        playKey: `${current.videoId}:${upcoming.ep_num}`,
        src: url,
        time: 0,
      });
    } catch {
      toast("下一集暂时打不开", "info");
    } finally {
      advancing.current = false;
    }
  };

  if (!mini) return null;
  const w = mini.landscape ? 196 : 118;
  const h = mini.landscape ? 112 : 210;

  const restore = () => {
    const time = videoRef.current?.el()?.currentTime ?? mini.time;
    if (stack.length === 0) setTab("home");
    setFs(false);
    finishMini({ ...mini, time });
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-mini-btn]")) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: 0, on: true };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current.on) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current.moved += Math.hypot(dx, dy);
    const next = {
      x: Math.min(Math.max(8, posRef.current.x + dx), window.innerWidth - w - 8),
      y: Math.min(Math.max(8, posRef.current.y + dy), window.innerHeight - h - 8),
    };
    drag.current.x = e.clientX;
    drag.current.y = e.clientY;
    posRef.current = next;
    setPos(next);
  };
  const onUp = () => {
    if (!drag.current.on) return;
    const moved = drag.current.moved;
    drag.current.on = false;
    if (moved < 8) restore();
  };

  return createPortal(
    <div
      ref={frame}
      className="hg-mini"
      style={{ width: w, height: h, left: pos.x, top: pos.y }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}>
      <div className="hg-mini-video">
        <VideoSurface
          key={mini.playKey}
          ref={videoRef}
          src={mini.src}
          poster={mini.poster}
          autoPlay
          active
          startAt={mini.time}
          muted={muted}
          volume={volume}
          rate={mini.rate}
          fit="contain"
          onPlaying={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onEnded={() => { void playNext(); }}
        />
      </div>
      <button type="button" data-mini-btn className="hg-mini-close" aria-label="关闭小窗" onClick={() => dismissMini()}>
        <IClose size={14} />
      </button>
      <div className="hg-mini-bar">
        <button type="button" data-mini-btn aria-label={paused ? "播放" : "暂停"} onClick={() => videoRef.current?.toggle()}>
          {paused ? <IPlayF size={14} /> : <IPauseF size={14} />}
        </button>
        <button type="button" data-mini-btn aria-label="返回播放页" onClick={restore}>
          <IExpand size={13} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
