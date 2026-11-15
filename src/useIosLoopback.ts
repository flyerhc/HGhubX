import { useEffect, useState } from "react";
import Hls from "hls.js";
import { iosLoopbackOrigin, platform } from "./api";

/** iOS 15–17.0 没有 MSE。origin 就绪前不要把 hg:// 交给系统播放器。 */
export function useIosLoopback(): { needed: boolean; ready: boolean; origin: string } {
  const needed = platform === "ios" && !Hls.isSupported();
  const [origin, setOrigin] = useState("");
  const [ready, setReady] = useState(!needed);

  useEffect(() => {
    if (!needed) return undefined;
    let alive = true;
    iosLoopbackOrigin().then((value) => {
      if (!alive) return;
      setOrigin(value);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [needed]);

  return { needed, ready, origin };
}
