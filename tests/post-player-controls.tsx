import { useState } from "react";
import { createRoot } from "react-dom/client";
import Player from "../src/components/Player";
import { platform } from "../src/api";
import { runBack } from "../src/back";
import "../src/index.css";

const fixture = {
  ready: false,
  setActive: (_active: boolean) => {},
  setControls: (_controls: boolean) => {},
  setMounted: (_mounted: boolean) => {},
  back: runBack,
  mediaReady() {
    const video = document.querySelector("video");
    if (!video) throw new Error("Expected a player before media readiness");
    video.currentTime = 3661;
    video.dispatchEvent(new Event("loadedmetadata"));
    video.dispatchEvent(new Event("loadeddata"));
    video.dispatchEvent(new Event("timeupdate"));
  },
};
Object.assign(window, { postControlsFixture: fixture, __TAURI_INTERNALS__: {
  async invoke(command: string) {
    if (command === "playback_log_status") return { enabled: false, path: null, error: null };
    return null;
  },
} });

function Harness() {
  const [active, setActive] = useState(true);
  const [controls, setControls] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [muted, setMuted] = useState(false);
  fixture.setActive = setActive;
  fixture.setControls = setControls;
  fixture.setMounted = setMounted;
  fixture.ready = true;
  return <main className={`plat-${platform}`} style={{ position: "absolute", inset: 0, overflow: "auto", padding: 12 }}>
    <button id="outside-player" style={{ display: "block", marginBottom: 12 }}>播放器外的焦点</button>
    <div data-player-host style={{ position: "relative", width: "100%", maxWidth: 760, height: "min(52vh, 420px)", marginInline: "auto", containerType: "inline-size", transform: "translateZ(0)", overflow: "hidden" }}>
      {mounted && <Player src="https://media.fixture.invalid/story.m3u8" autoPlay active={active}
        controls={controls} muted={muted} onToggleMute={() => setMuted(value => !value)} className="w-full h-full" />}
    </div>
    <p>中性的离线播放器控制场景。</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
