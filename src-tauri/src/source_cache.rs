//! Discovery snapshots are selectable hints. Only a successful publisher read
//! in this process can grant credential trust; restoring JSON never does.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const FRESH_SECONDS: u64 = 10 * 60;
pub(crate) const STALE_SECONDS: u64 = 24 * 60 * 60;
const MAX_DISK_BYTES: u64 = 128 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Mirror {
    pub url: String,
    pub host: String,
    pub root: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Snapshot {
    pub source: String,
    pub script: String,
    pub fetched_at: u64,
    pub items: Vec<Mirror>,
}

impl Snapshot {
    fn age(&self, now: u64) -> Option<u64> {
        now.checked_sub(self.fetched_at)
    }

    pub(crate) fn fresh(&self, now: u64) -> bool {
        self.age(now).is_some_and(|age| age < FRESH_SECONDS)
    }

    pub(crate) fn usable(&self, now: u64) -> bool {
        !self.items.is_empty() && self.age(now).is_some_and(|age| age < STALE_SECONDS)
    }
}

type Refresh = tokio::sync::OnceCell<Result<Snapshot, String>>;

#[derive(Default)]
struct State {
    file: Option<PathBuf>,
    snapshot: Option<Snapshot>,
    verified: bool,
    last_error: Option<(Instant, String)>,
    loading: Weak<Refresh>,
}

impl State {
    fn known(&self, origin: &str, now: u64) -> bool {
        self.snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.usable(now) && snapshot.items.iter().any(|item| item.url == origin)
        })
    }

    fn trusted(&self, origin: &str, now: u64) -> bool {
        self.verified && self.known(origin, now)
    }

    fn restored(&mut self, snapshot: Option<Snapshot>) {
        self.snapshot = snapshot;
        self.verified = false;
        self.last_error = None;
    }

    fn published(&mut self, snapshot: Snapshot) {
        self.snapshot = Some(snapshot);
        self.verified = true;
        self.last_error = None;
    }

    fn refresh(&mut self) -> Arc<Refresh> {
        if let Some(loading) = self.loading.upgrade() {
            loading
        } else {
            let loading = Arc::new(Refresh::new());
            self.loading = Arc::downgrade(&loading);
            loading
        }
    }
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub(crate) fn bind(dir: &Path, validate: impl FnOnce(Snapshot) -> Option<Snapshot>) {
    let file = dir.join("source-discovery.json");
    let snapshot = std::fs::metadata(&file).ok().filter(|info| info.len() <= MAX_DISK_BYTES)
        .and_then(|_| std::fs::read(&file).ok())
        .and_then(|bytes| serde_json::from_slice::<Snapshot>(&bytes).ok())
        .and_then(validate)
        .filter(|snapshot| snapshot.usable(now()));
    let mut state = STATE.lock().unwrap_or_else(|error| error.into_inner());
    state.file = Some(file);
    state.restored(snapshot);
}

pub(crate) fn cached() -> Option<Snapshot> {
    STATE.lock().unwrap_or_else(|error| error.into_inner()).snapshot.clone()
        .filter(|snapshot| snapshot.usable(now()))
}

pub(crate) fn known(origin: &str) -> bool {
    STATE.lock().unwrap_or_else(|error| error.into_inner()).known(origin, now())
}

pub(crate) fn trusted(origin: &str) -> bool {
    STATE.lock().unwrap_or_else(|error| error.into_inner()).trusted(origin, now())
}

pub(crate) fn refresh() -> Arc<Refresh> {
    STATE.lock().unwrap_or_else(|error| error.into_inner()).refresh()
}

pub(crate) fn published(snapshot: Snapshot) {
    let mut state = STATE.lock().unwrap_or_else(|error| error.into_inner());
    state.published(snapshot.clone());
    // Persistence is best-effort: a read-only data directory must not discard a
    // successfully verified online result. Write under the same lock as state.
    if let (Some(file), Ok(bytes)) = (&state.file, serde_json::to_vec(&snapshot)) {
        let temporary = file.with_extension("json.tmp");
        if std::fs::write(&temporary, bytes).is_ok() {
            let _ = std::fs::rename(&temporary, file);
        }
    }
}

pub(crate) fn failed(error: &str) {
    STATE.lock().unwrap_or_else(|poison| poison.into_inner()).last_error = Some((Instant::now(), error.to_owned()));
}

pub(crate) fn recent_error() -> Option<String> {
    STATE.lock().unwrap_or_else(|error| error.into_inner()).last_error.as_ref()
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(30))
        .map(|(_, error)| error.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(at: u64, host: &str) -> Snapshot {
        Snapshot { source: "https://publisher.example/".into(), script: "https://publisher.example/publish.js".into(), fetched_at: at,
            items: vec![Mirror { url: format!("https://{host}"), host: host.into(), root: host.into() }] }
    }

    #[test]
    fn freshness_stale_expiry_and_clock_rollback_are_bounded() {
        let entry = snapshot(100, "mirror.example");
        assert!(entry.fresh(100 + FRESH_SECONDS - 1));
        assert!(!entry.fresh(100 + FRESH_SECONDS));
        assert!(entry.usable(100 + STALE_SECONDS - 1));
        assert!(!entry.usable(100 + STALE_SECONDS));
        assert!(!entry.usable(99));
    }

    #[test]
    fn disk_restore_is_selectable_but_never_grants_credential_trust() {
        let original = snapshot(100, "mirror.example");
        let disk = serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
        let mut state = State::default();
        state.restored(Some(disk));
        assert!(state.known("https://mirror.example", 110));
        assert!(!state.trusted("https://mirror.example", 110));
        state.published(original);
        assert!(state.trusted("https://mirror.example", 110));
        assert!(!state.trusted("https://mirror.example", 100 + STALE_SECONDS));
    }

    #[test]
    fn failed_refresh_keeps_bounded_previous_snapshot_and_new_success_replaces_trust() {
        let mut state = State::default();
        state.published(snapshot(100, "old.example"));
        state.last_error = Some((Instant::now(), "publisher offline".into()));
        assert!(state.known("https://old.example", 100 + FRESH_SECONDS));
        assert!(!state.known("https://old.example", 100 + STALE_SECONDS));
        state.published(snapshot(200, "new.example"));
        assert!(!state.trusted("https://old.example", 201));
        assert!(state.trusted("https://new.example", 201));
        assert!(state.last_error.is_none());
    }

    #[test]
    fn refresh_callers_share_one_inflight_and_release_it_after_completion() {
        let mut state = State::default();
        let first = state.refresh();
        let second = state.refresh();
        assert!(Arc::ptr_eq(&first, &second));
        let previous = Arc::downgrade(&first);
        drop(first);
        drop(second);
        assert!(previous.upgrade().is_none());
        assert!(state.refresh().get().is_none());
    }

    #[tokio::test]
    async fn shared_refresh_initializes_only_once_for_concurrent_callers() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let mut state = State::default();
        let first = state.refresh();
        let second = state.refresh();
        let initialize = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(snapshot(100, "mirror.example"))
        };
        let (a, b) = tokio::join!(first.get_or_init(initialize), second.get_or_init(initialize));
        assert_eq!(a, b);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
