//! 会话持久化：token + 用户资料存到应用数据目录。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// This is a cache selector, never an authentication capability.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationIdentity {
    pub origin: String,
    pub user_id: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TvMigration {
    version: u8,
    pending: Option<MigrationIdentity>,
    complete: bool,
}

fn write_durable(path: &std::path::Path, value: &impl Serialize) -> Result<(), String> {
    use std::io::Write;
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent).and_then(|dir| dir.sync_all()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Session {
    // 旧版本没有 origin：不能推断其 token 属于哪个镜像，升级后必须重新登录。
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub user: serde_json::Value,
    /// Process-local identity epoch, so even logout/login with a reused token invalidates old work.
    #[serde(skip)]
    pub revision: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_are_bound_to_origin() {
        let store = SessionStore::new();
        store.set(
            "https://huangguoai.com",
            "secret-token".into(),
            json!({"id": 1}),
        );
        assert_eq!(
            store.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
        assert_eq!(store.token("https://huangguoai.ai"), None);
        assert_eq!(store.token("https://evil.example"), None);
        assert!(store.user("https://evil.example").is_null());
        store.clear();
        assert_eq!(store.token("https://huangguoai.com"), None);
    }

    #[test]
    fn legacy_sessions_are_not_assigned_to_current_line() {
        let store = SessionStore::new();
        *store.current.lock().unwrap() =
            serde_json::from_str(r#"{"token":"legacy","user":{"id":1}}"#).unwrap();
        assert_eq!(store.token("https://huangguoai.com"), None);
        assert!(store.user("https://huangguoai.com").is_null());
    }

    #[test]
    fn late_profile_and_logout_cannot_replace_a_new_session() {
        let store = SessionStore::new();
        let origin = "https://example.com";
        store.set(origin, "first".into(), json!({"id": 1}));
        let first = store.snapshot(origin).unwrap();
        store.set(origin, "second".into(), json!({"id": 2}));
        assert!(!store.update_user_if_current(&first, json!({"id": 1, "nickname": "late"})));
        assert!(!store.clear_if_current(&first));
        assert_eq!(store.user(origin)["id"], 2);
        let second = store.snapshot(origin).unwrap();
        assert!(!store.update_user_if_current(&second, json!({"id": 1})));
        assert!(store.update_user_if_current(&second, json!({"id": 2, "nickname": "fresh"})));
    }

    #[test]
    fn relogin_with_same_token_still_invalidates_old_requests() {
        let store = SessionStore::new();
        let origin = "https://example.com";
        store.set(origin, "same".into(), json!({"id": 1}));
        let old = store.snapshot(origin).unwrap();
        store.clear();
        store.set(origin, "same".into(), json!({"id": 1}));
        assert!(!store.is_current(&old));
        assert!(!store.clear_if_current(&old));
        assert!(serde_json::to_value(store.snapshot(origin).unwrap()).unwrap().get("revision").is_none());
    }

    #[test]
    fn late_login_cannot_replace_a_newer_account() {
        let store = SessionStore::new();
        let origin = "https://example.com";
        let revision = store.revision();
        assert!(store.set_if_revision(revision, origin, "new".into(), json!({"id": 2})));
        assert!(!store.set_if_revision(revision, origin, "late".into(), json!({"id": 1})));
        assert_eq!(store.user(origin)["id"], 2);
    }

    struct FixtureDir(PathBuf);
    impl FixtureDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let nonce = NEXT.fetch_add(1, Ordering::Relaxed);
            let clock = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("hghubx-tv-session-{}-{clock}-{nonce}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn seed(&self) {
            std::fs::write(self.0.join("session.json"), json!({
                "origin":"https://example.com", "token":"old-credential", "user":{"id":17,"nickname":"old-profile"}
            }).to_string()).unwrap();
        }
        fn tv(&self) -> SessionStore {
            let store = SessionStore::new();
            store.configure_package("com.hghubx.tv");
            store.bind(self.0.clone());
            store
        }
    }
    impl Drop for FixtureDir {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn tv_records_only_exact_identity_before_erasing_old_credentials() {
        let dir = FixtureDir::new(); dir.seed();
        let store = dir.tv();
        assert!(store.local_mode());
        assert!(store.token("https://example.com").is_none());
        assert!(store.snapshot("https://example.com").is_none());
        assert!(store.user("https://example.com").is_null());
        // A line change before frontend boot must not erase the migration source.
        let original = std::fs::read_to_string(dir.0.join("session.json")).unwrap();
        store.clear();
        assert_eq!(std::fs::read_to_string(dir.0.join("session.json")).unwrap(), original);
        let pending = store.pending_migration().unwrap().unwrap();
        assert_eq!(pending, MigrationIdentity { origin:"https://example.com".into(), user_id:17 });
        let persisted = std::fs::read_to_string(dir.0.join("tv-library-migration.json")).unwrap();
        assert!(!persisted.contains("token"));
        assert!(!persisted.contains("nickname"));
        let cleared: Session = serde_json::from_str(&std::fs::read_to_string(dir.0.join("session.json")).unwrap()).unwrap();
        assert!(cleared.token.is_empty()); assert!(cleared.user.is_null());
        assert!(!store.set_if_revision(store.revision(), "https://example.com", "new".into(), json!({"id":18})));
    }

    #[test]
    fn tv_migration_survives_restart_and_acknowledges_once() {
        let dir = FixtureDir::new(); dir.seed();
        let identity = dir.tv().pending_migration().unwrap();
        let restarted = dir.tv();
        assert_eq!(restarted.pending_migration().unwrap(), identity);
        assert!(restarted.complete_migration(Some(MigrationIdentity { origin:"https://example.com".into(), user_id:99 })).is_err());
        assert_eq!(restarted.pending_migration().unwrap(), identity);
        restarted.complete_migration(identity.clone()).unwrap();
        restarted.complete_migration(identity).unwrap();
        assert!(dir.tv().pending_migration().unwrap().is_none());
        let marker: TvMigration = serde_json::from_str(&std::fs::read_to_string(dir.0.join("tv-library-migration.json")).unwrap()).unwrap();
        assert!(marker.complete); assert!(marker.pending.is_none());
    }

    #[test]
    fn tv_failed_identity_write_retains_credentials_without_using_them() {
        let dir = FixtureDir::new(); dir.seed();
        // A directory at the destination deterministically fails on all platforms.
        let obstruction = dir.0.join("tv-library-migration.json");
        std::fs::create_dir(&obstruction).unwrap();
        let store = dir.tv();
        let original = std::fs::read_to_string(dir.0.join("session.json")).unwrap();
        assert!(store.pending_migration().is_err());
        assert!(store.token("https://example.com").is_none());
        assert_eq!(std::fs::read_to_string(dir.0.join("session.json")).unwrap(), original);
        std::fs::remove_dir(obstruction).unwrap();
        assert_eq!(store.pending_migration().unwrap().unwrap().user_id,17);
    }

    #[test]
    fn standard_package_keeps_account_restore_and_ignores_tv_migration() {
        let dir = FixtureDir::new(); dir.seed();
        let store = SessionStore::new();
        store.configure_package("com.hghubx.app"); store.bind(dir.0.clone());
        assert!(!store.local_mode());
        assert!(store.token("https://example.com").is_some());
        assert_eq!(store.user("https://example.com")["id"], 17);
        assert!(store.pending_migration().unwrap().is_none());
        assert!(!dir.0.join("tv-library-migration.json").exists());
    }
}

pub struct SessionStore {
    pub file: Mutex<Option<PathBuf>>,
    pub current: Mutex<Session>,
    local_mode: AtomicBool,
    migration_lock: Mutex<()>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            file: Mutex::new(None),
            current: Mutex::new(Session::default()),
            local_mode: AtomicBool::new(false),
            migration_lock: Mutex::new(()),
        }
    }

    /// Package identity is selected by native configuration, not by frontend input.
    pub fn configure_package(&self, identifier: &str) {
        self.local_mode.store(identifier == "com.hghubx.tv", Ordering::Release);
    }

    pub fn local_mode(&self) -> bool {
        self.local_mode.load(Ordering::Acquire)
    }

    pub fn bind(&self, dir: PathBuf) {
        let mut path = dir;
        path.push("session.json");
        if self.local_mode() {
            // Do not restore credentials even if preparing the migration later fails.
            *self.file.lock().unwrap() = Some(path);
            return;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(sess) = serde_json::from_str::<Session>(&text) {
                *self.current.lock().unwrap() = sess;
            }
        }
        *self.file.lock().unwrap() = Some(path);
    }

    /// Persist the exact old identity before erasing credentials. This is retried
    /// from app_boot after interrupted writes; the completed tombstone is retained.
    pub fn pending_migration(&self) -> Result<Option<MigrationIdentity>, String> {
        if !self.local_mode() { return Ok(None); }
        let _guard = self.migration_lock.lock().map_err(|_| "TV 迁移状态锁失败")?;
        self.prepare_migration().map(|state| state.pending)
    }

    fn prepare_migration(&self) -> Result<TvMigration, String> {
        let session_path = self.file.lock().map_err(|_| "TV 存储路径锁失败")?
            .clone().ok_or("TV 本机存储尚未就绪")?;
        let migration_path = session_path.with_file_name("tv-library-migration.json");
        let migration = match std::fs::read_to_string(&migration_path) {
            Ok(text) => {
                let state: TvMigration = serde_json::from_str(&text).map_err(|_| "TV 迁移记录读取失败，请保留本机数据后重试")?;
                if state.version != 1 || (state.complete && state.pending.is_some()) {
                    return Err("TV 迁移记录版本异常".into());
                }
                state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let session = match std::fs::read_to_string(&session_path) {
                    Ok(text) => Some(serde_json::from_str::<Session>(&text)
                        .map_err(|_| "旧会话格式异常，迁移尚未完成，请保留本机数据后重试")?),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(format!("旧会话读取失败：{error}")),
                };
                let pending = session.and_then(|session| {
                    if session.token.is_empty() { return None; }
                    let user_id = session.user.get("id")?.as_u64()?;
                    if user_id == 0 || user_id > 9_007_199_254_740_991 { return None; }
                    let parsed = url::Url::parse(&session.origin).ok()?;
                    if !matches!(parsed.scheme(), "http" | "https")
                        || parsed.origin().ascii_serialization() != session.origin { return None; }
                    Some(MigrationIdentity { origin: session.origin, user_id })
                });
                let state = TvMigration { version: 1, pending, complete: false };
                write_durable(&migration_path, &state).map_err(|error| format!("TV 迁移身份保存失败：{error}"))?;
                state
            }
            Err(error) => return Err(format!("TV 迁移记录读取失败：{error}")),
        };
        // A failure here preserves the durable pending identity and blocks the
        // frontend acknowledgement. Memory has never held the old session.
        write_durable(&session_path, &Session::default()).map_err(|error| format!("TV 旧会话清理失败：{error}"))?;
        Ok(migration)
    }

    pub fn complete_migration(&self, expected: Option<MigrationIdentity>) -> Result<(), String> {
        if !self.local_mode() { return Err("当前安装未启用 TV 本地模式".into()); }
        let _guard = self.migration_lock.lock().map_err(|_| "TV 迁移状态锁失败")?;
        let state = self.prepare_migration()?;
        if state.complete { return Ok(()); }
        if state.pending != expected { return Err("TV 待迁移身份已变化，请重启后重试".into()); }
        let path = self.file.lock().map_err(|_| "TV 存储路径锁失败")?
            .clone().ok_or("TV 本机存储尚未就绪")?.with_file_name("tv-library-migration.json");
        write_durable(&path, &TvMigration { version: 1, pending: None, complete: true })
            .map_err(|error| format!("TV 迁移确认保存失败：{error}"))
    }

    pub fn token(&self, origin: &str) -> Option<String> {
        if self.local_mode() { return None; }
        let cur = self.current.lock().unwrap();
        (cur.origin == origin && !cur.token.is_empty()).then(|| cur.token.clone())
    }

    pub fn user(&self, origin: &str) -> serde_json::Value {
        if self.local_mode() { return serde_json::Value::Null; }
        let cur = self.current.lock().unwrap();
        if cur.origin == origin && !cur.token.is_empty() {
            cur.user.clone()
        } else {
            serde_json::Value::Null
        }
    }

    pub fn snapshot(&self, origin: &str) -> Option<Session> {
        if self.local_mode() { return None; }
        let cur = self.current.lock().unwrap();
        (cur.origin == origin && !cur.token.is_empty()).then(|| cur.clone())
    }

    pub fn revision(&self) -> u64 {
        self.current.lock().unwrap().revision
    }

    pub fn set_if_revision(&self, expected_revision: u64, origin: &str, token: String, user: serde_json::Value) -> bool {
        if self.local_mode() { return false; }
        {
            let mut cur = self.current.lock().unwrap();
            if cur.revision != expected_revision { return false; }
            cur.origin = origin.to_string();
            cur.token = token;
            cur.user = user;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
        true
    }

    fn same_identity(current: &Session, expected: &Session) -> bool {
        current.revision == expected.revision
            && current.origin == expected.origin
            && current.token == expected.token
            && current.user.get("id") == expected.user.get("id")
    }

    pub fn is_current(&self, expected: &Session) -> bool {
        if self.local_mode() { return false; }
        Self::same_identity(&self.current.lock().unwrap(), expected)
    }

    pub fn update_user_if_current(&self, expected: &Session, user: serde_json::Value) -> bool {
        if self.local_mode() { return false; }
        {
            let mut cur = self.current.lock().unwrap();
            if !Self::same_identity(&cur, expected) || user.get("id") != expected.user.get("id") {
                return false;
            }
            cur.user = user;
        }
        self.persist();
        true
    }

    pub fn clear_if_current(&self, expected: &Session) -> bool {
        {
            let mut cur = self.current.lock().unwrap();
            if !Self::same_identity(&cur, expected) { return false; }
            cur.token.clear();
            cur.origin.clear();
            cur.user = serde_json::Value::Null;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
        true
    }

    pub fn set(&self, origin: &str, token: String, user: serde_json::Value) {
        if self.local_mode() { return; }
        {
            let mut cur = self.current.lock().unwrap();
            cur.origin = origin.to_string();
            cur.token = token;
            cur.user = user;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
    }

    pub fn clear(&self) {
        {
            let mut cur = self.current.lock().unwrap();
            cur.token.clear();
            cur.origin.clear();
            cur.user = serde_json::Value::Null;
            cur.revision = cur.revision.wrapping_add(1);
        }
        self.persist();
    }

    fn persist(&self) {
        // Only prepare_migration may clear the old file, after identity is durable.
        if self.local_mode() { return; }
        // Keep state locked through the write so a slower earlier writer cannot persist over a new login.
        let snapshot = self.current.lock().unwrap();
        if let Some(path) = self.file.lock().unwrap().as_ref() {
            if let Ok(text) = serde_json::to_string_pretty(&*snapshot) {
                let _ = std::fs::write(path, text);
            }
        }
    }
}
