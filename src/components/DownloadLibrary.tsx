import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "../api";
import { useStore } from "../store";
import { Button } from "./ios/controls";
import { IChevR, IDownload } from "../icons";

type Item = { id: string; name: string; bytes: number; modified: number };

function fmtBytes(n: number) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 已保存的单集。只列出用户点过下载的成品，不提供批量抓取。 */
export default function DownloadLibrary() {
  const { toast } = useStore();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState("");

  const reload = () => {
    invoke<Item[]>("list_downloads")
      .then(setItems)
      .catch((error) => {
        setItems([]);
        toast(typeof error === "string" ? error : "读取下载失败", "info");
      });
  };

  useEffect(() => {
    if (open) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const remove = (id: string) => {
    setBusy(id);
    invoke("delete_download", { id })
      .then(() => {
        setItems((list) => (list || []).filter((item) => item.id !== id));
        toast("已删除", "ok");
      })
      .catch((error) => toast(typeof error === "string" ? error : "删除失败", "info"))
      .finally(() => setBusy(""));
  };

  const share = (id: string) => {
    setBusy(id);
    invoke("export_download", { id })
      .then(() => toast(platform === "ios" ? "已打开系统分享" : "已在文件夹中定位", "ok"))
      .catch((error) => toast(typeof error === "string" ? error : "导出失败", "info"))
      .finally(() => setBusy(""));
  };

  return (
    <>
      <Button onClick={() => setOpen((value) => !value)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
        <span className="ios-setting-icon"><IDownload size={16} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] text-on">已下载的视频</div>
          <div className="text-[12px] text-mut">只保存当前正在看的这一集{platform === "ios" ? "，手机在「文件」App 的 HGhubX 里" : ""}</div>
        </div>
        <IChevR size={15} className={`text-mut transition-transform ${open ? "rotate-90" : ""}`} />
      </Button>
      {open && (
        <div className="px-3.5 pb-3 flex flex-col gap-2">
          {items === null && <div className="text-[12px] text-mut">读取中…</div>}
          {items && items.length === 0 && <div className="text-[12px] text-mut">还没有下载</div>}
          {items?.map((item) => (
            <div key={item.id} className="flex items-center gap-2 min-w-0">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-on truncate">{item.name}</div>
                <div className="text-[11px] text-mut">{fmtBytes(item.bytes)}</div>
              </div>
              <Button disabled={busy === item.id} onClick={() => share(item.id)} className="shrink-0 h-8 px-2 rounded-full text-[12px] hg-chip pressable">导出</Button>
              <Button disabled={busy === item.id} onClick={() => remove(item.id)} className="shrink-0 h-8 px-2 rounded-full text-[12px] hg-chip pressable">删除</Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
