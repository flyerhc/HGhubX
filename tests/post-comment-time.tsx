import { createRoot } from "react-dom/client";
import { CommentsPanel } from "../src/components/Panels";
import { normalizeComment, relativeCommentTime } from "../src/commentData";
import { AppProvider } from "../src/store";
import type { Comment } from "../src/types";
import "../src/index.css";

const now = Date.now();
const withoutReplies: Comment = {
  id: 1,
  user_id: 1,
  nickname: "无回复用户",
  avatar: "",
  avatar_color: "",
  text: "只有创建时间",
  created_at: new Date(now - 90 * 60 * 1000).toISOString(),
  like_count: 1,
  liked: false,
  reply_id: 0,
  reply_list: [],
};
const withReplies: Comment = {
  id: 2,
  user_id: 2,
  nickname: "有回复用户",
  avatar: "",
  avatar_color: "",
  text: "有两条回复",
  created_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
  like_count: 2,
  liked: false,
  reply_id: 0,
  reply_list: [
    { ...withoutReplies, id: 21, text: "回复一" },
    { ...withoutReplies, id: 22, text: "回复二" },
  ],
};

const normalizedNoReplies = normalizeComment(withoutReplies, now);
const normalizedWithReplies = normalizeComment(withReplies, now);
const malformedNumericTimestamp = "99999999999999999999";

Object.assign(window, {
  commentTimeFixture: {
    normalizedNoReplies,
    normalizedWithReplies,
    malformedNumericTimestamp,
    malformedNumericTime: relativeCommentTime(malformedNumericTimestamp, 1e21),
  },
  __TAURI_INTERNALS__: {
    invoke(command: string) {
      if (command === "app_boot") {
        return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
      }
      if (command === "debug_log") return Promise.resolve();
      if (command === "api_post_comments") {
        return Promise.resolve({
          ep: 1,
          items: [withoutReplies, withReplies],
          pagination: { page: 1, pages: 1, size: 20, total: 2 },
        });
      }
      return Promise.reject(`Unexpected IPC: ${command}`);
    },
  },
});

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <div style={{ position: "relative", width: 390, height: 700, background: "var(--p-bg)" }}>
      <CommentsPanel videoId={42} ep={1} total={2} kind="post" onClose={() => {}} />
    </div>
  </AppProvider>,
);
