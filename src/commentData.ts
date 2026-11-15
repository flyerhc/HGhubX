import type { Comment } from "./types";

export type NormalizedComment = Omit<Comment, "time" | "reply_count" | "reply_list"> & {
  time: string;
  reply_count: number;
  reply_list?: NormalizedComment[];
};

function nonEmptyText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseTimestamp(value: string): number {
  const raw = value.trim();
  if (!raw) return Number.NaN;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return raw.length <= 10 ? numeric * 1000 : numeric;
  }
  const isoLike = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = Date.parse(isoLike);
  return Number.isFinite(parsed) ? parsed : Date.parse(raw);
}

/** 上游视频评论已是“1天前”这类文案；吃瓜评论只有 created_at，这里补齐一致风格。 */
export function relativeCommentTime(createdAt: unknown, now = Date.now()): string {
  const raw = nonEmptyText(createdAt);
  if (!raw) return "";
  const timestamp = parseTimestamp(raw);
  if (!Number.isFinite(timestamp)) return raw;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 24 * 60 * 60) return `${Math.floor(seconds / 3600)}小时前`;
  if (seconds < 30 * 24 * 60 * 60) return `${Math.floor(seconds / 86400)}天前`;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return raw;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function replyCount(value: unknown, replies: NormalizedComment[]): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : replies.length;
}

export function normalizeComment(comment: Comment, now = Date.now()): NormalizedComment {
  const replies = Array.isArray(comment.reply_list)
    ? comment.reply_list.map((reply) => normalizeComment(reply, now))
    : [];
  const created = nonEmptyText(comment.created_at);
  return {
    ...comment,
    time: nonEmptyText(comment.time) || relativeCommentTime(created, now),
    reply_count: replyCount(comment.reply_count, replies),
    reply_list: replies,
  };
}
