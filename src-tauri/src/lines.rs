//! Upstream lines and mirrors published by the upstream address pages.
//! Publisher scripts are parsed as data; remote JavaScript is never executed.

use dom_query::Document;
use serde_json::{json, Value};
use crate::source_cache::{self, Mirror, Snapshot};
use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

pub const FIXED: [(&str, &str); 1] = [("主站", "https://huangguoai.com")];
const PUBLISH_PAGES: [&str; 2] = [
    "https://huang-guo.pages.dev/",
    "https://huangguoai.pages.dev/",
];
const MIRROR_MAX: usize = 60;
const PUBLISH_ARRAY_MAX: usize = 256;
const RECOMMENDED_MAX: usize = 20;
const PAGE_TIMEOUT: Duration = Duration::from_secs(8);
const PUBLISH_HEDGE: Duration = Duration::from_millis(500);
const MAX_PUBLISH_BYTES: usize = 512 * 1024;
const AUTO_PROBE_PATH: &str = "/api/videos?page=1&size=1";
const AUTO_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const AUTO_MIRROR_MAX: usize = 12;
const PROBE_CONCURRENCY: usize = 4;
const PER_ROOT_MAX: usize = 3;
static CANDIDATE_ROTATION: AtomicUsize = AtomicUsize::new(0);
static PROBE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(PROBE_CONCURRENCY);

pub fn is_publisher_or_retired(origin: &str) -> bool {
    url::Url::parse(origin).ok().and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| {
            let host = host.trim_end_matches('.');
            ["huangguoai.ai", "huangguo.ai", "huangguoai.pages.dev", "huang-guo.pages.dev"]
                .iter().any(|blocked| host == *blocked || host.ends_with(&format!(".{blocked}")))
        })
}

pub fn bind(dir: &Path) {
    source_cache::bind(dir, |mut snapshot| {
        if !PUBLISH_PAGES.contains(&snapshot.source.as_str())
            || absolute(&snapshot.source, &snapshot.script).is_err()
            || snapshot.items.len() > MIRROR_MAX {
            return None;
        }
        let mut seen = HashSet::new();
        snapshot.items.retain(|item| {
            crate::net::normalize_base(&item.url).as_deref() == Some(item.url.as_str())
                && !is_publisher_or_retired(&item.url) && !is_fixed(&item.url)
                && valid_dns_name(&item.host) && valid_dns_name(&item.root)
                && url::Url::parse(&item.url).ok().and_then(|url| url.host_str().map(str::to_owned)).as_deref() == Some(item.host.as_str())
                && (item.host == item.root || item.host.ends_with(&format!(".{}", item.root)))
                && seen.insert(item.url.clone())
        });
        (!snapshot.items.is_empty()).then_some(snapshot)
    });
}

pub fn is_known_mirror(origin: &str) -> bool {
    !is_publisher_or_retired(origin) && source_cache::known(origin)
}

pub fn is_trusted_mirror(origin: &str) -> bool {
    !is_publisher_or_retired(origin) && source_cache::trusted(origin)
}

pub fn fixed() -> Value {
    json!(FIXED.iter().map(|(name, url)| json!({ "name": name, "url": url })).collect::<Vec<_>>())
}

pub fn is_fixed(url: &str) -> bool {
    FIXED.iter().any(|(_, known)| *known == url)
}

#[derive(Clone)]
struct PublishedPage {
    source: String,
    script: String,
    items: Vec<Value>,
}

#[derive(Clone)]
struct Discovery {
    snapshot: Snapshot,
    stale: bool,
    error: Option<String>,
}

impl Discovery {
    fn json(&self) -> Value {
        let items: Vec<_> = self.snapshot.items.iter().map(|item| json!({
            "url": item.url, "host": item.host, "root": item.root,
        })).collect();
        let mut value = json!({ "source": self.snapshot.source, "script": self.snapshot.script,
            "items": items, "recommended_source": self.snapshot.source,
            "recommended": items.iter().take(RECOMMENDED_MAX).collect::<Vec<_>>(),
            "updated_at": self.snapshot.fetched_at.saturating_mul(1000), "stale": self.stale,
            "errors": self.error.iter().collect::<Vec<_>>() });
        if let Some(error) = &self.error { value["discovery_error"] = json!(error); }
        value
    }
}

fn cached_discovery(error: Option<String>) -> Option<Discovery> {
    source_cache::cached().map(|snapshot| Discovery {
        stale: !snapshot.fresh(source_cache::now()) || error.is_some(), snapshot, error,
    })
}

async fn discover(force: bool, credentials: bool) -> Result<Discovery, String> {
    if !force {
        if let Some(error) = source_cache::recent_error() {
            return cached_discovery(Some(error.clone())).ok_or(error);
        }
        if let Some(cached) = cached_discovery(None).filter(|entry| {
            !entry.stale && (!credentials || entry.snapshot.items.iter().any(|item| is_trusted_mirror(&item.url)))
        }) {
            return Ok(cached);
        }
    }
    let loading = source_cache::refresh();
    let result = loading.get_or_init(|| async {
        let result = fetch_publishers().await.and_then(|page| {
            let items: Vec<Mirror> = page.items.into_iter().filter_map(|item| serde_json::from_value(item).ok()).collect();
            if items.is_empty() { return Err("地址发布页里没有可用的镜像地址".into()); }
            Ok(Snapshot { source: page.source, script: page.script, items, fetched_at: source_cache::now() })
        });
        match &result {
            Ok(snapshot) => source_cache::published(snapshot.clone()),
            Err(error) => source_cache::failed(error),
        }
        result
    }).await.clone();
    match result {
        Ok(snapshot) => Ok(Discovery { snapshot, stale: false, error: None }),
        Err(error) => cached_discovery(Some(error.clone())).ok_or(error),
    }
}

/// Explicit refresh bypasses fresh TTL, but shares an already-running refresh.
pub async fn mirrors() -> Result<Value, String> {
    discover(true, false).await.map(|entry| entry.json())
}

/// Start the preferred publisher now, then hedge after 500 ms. A usable result
/// wins immediately; dropping the other future cancels its unfinished request.
async fn first_publisher<F, G>(primary: F, secondary: G, delay: Duration) -> Result<PublishedPage, String>
where
    F: std::future::Future<Output = Result<PublishedPage, String>>,
    G: std::future::Future<Output = Result<PublishedPage, String>>,
{
    tokio::pin!(primary);
    match tokio::time::timeout(delay, &mut primary).await {
        Ok(Ok(page)) => return Ok(page),
        Ok(Err(first)) => return secondary.await.map_err(|second| format!("{first}；{second}")),
        Err(_) => {}
    }
    tokio::pin!(secondary);
    tokio::select! {
        first = &mut primary => match first {
            Ok(page) => Ok(page),
            Err(first) => secondary.await.map_err(|second| format!("{first}；{second}")),
        },
        second = &mut secondary => match second {
            Ok(page) => Ok(page),
            Err(second) => primary.await.map_err(|first| format!("{first}；{second}")),
        },
    }
}

async fn fetch_publishers() -> Result<PublishedPage, String> {
    first_publisher(mirrors_from_page(PUBLISH_PAGES[0]), mirrors_from_page(PUBLISH_PAGES[1]), PUBLISH_HEDGE).await
}

async fn mirrors_from_page(page: &str) -> Result<PublishedPage, String> {
    // One deadline includes DNS, redirects, both bodies and parsing.
    tokio::time::timeout(PAGE_TIMEOUT, async {
        let html = get_text(page).await?;
        let script = script_src(page, &html)?;
        let js = get_text(&script).await?;
        let items = parse_mirrors(&js)?;
        Ok(PublishedPage {
            source: page.to_owned(),
            script,
            items,
        })
    })
    .await
    .map_err(|_| "获取地址发布页超时（8 秒）".to_owned())?
}

fn parse_mirrors(js: &str) -> Result<Vec<Value>, String> {
    let domains = js_array(js, "urls")?.unwrap_or_default();
    let subs = js_array(js, "subdomains")?.unwrap_or_default();
    if domains.is_empty() {
        return Err("发布脚本中没有找到镜像域名".into());
    }
    let domains: Vec<_> = domains.into_iter().map(|domain| domain.trim().trim_end_matches('/').to_ascii_lowercase())
        .filter(|domain| valid_dns_name(domain)).collect();
    let subs: Vec<_> = if subs.is_empty() { vec![String::new()] } else {
        subs.into_iter().map(|sub| sub.trim().to_ascii_lowercase()).filter(|sub| valid_dns_label(sub)).collect()
    };
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    // Round-robin roots before taking another subdomain of the same root.
    'hosts: for sub in subs {
        for domain in &domains {
            let host = if sub.is_empty() { domain.clone() } else { format!("{sub}.{domain}") };
            if !valid_dns_name(&host) || !seen.insert(host.clone()) { continue; }
            let Some(origin) = crate::net::normalize_base(&format!("https://{host}")) else { continue };
            if is_publisher_or_retired(&origin) || is_fixed(&origin) { continue; }
            items.push(json!({ "url": origin, "host": host, "root": domain }));
            if items.len() >= MIRROR_MAX { break 'hosts; }
        }
    }
    if items.is_empty() {
        Err("发布脚本中没有合法镜像地址".into())
    } else {
        Ok(items)
    }
}

fn valid_dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
}

fn valid_dns_name(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(valid_dns_label)
        && !["localhost", "local", "internal", "home.arpa"]
            .iter()
            .any(|suffix| value == *suffix || value.ends_with(&format!(".{suffix}")))
        && url::Url::parse(&format!("https://{value}"))
            .ok()
            .is_some_and(|parsed| matches!(parsed.host(), Some(url::Host::Domain(_))))
}

/// Bounded decoded body; the publisher's outer deadline also covers a slow body.
async fn get_text(raw: &str) -> Result<String, String> {
    let target = url::Url::parse(raw).map_err(|_| "发布地址无效")?;
    let mut response = crate::net::get(
        raw,
        PAGE_TIMEOUT,
        Some("text/html,application/javascript"),
        None,
    )
    .await?;
    // net::get checks DNS and redirects; publisher authority cannot cross origins.
    let final_url = response.url();
    if final_url.scheme() != "https"
        || final_url.origin() != target.origin()
        || (target.path().ends_with("/publish.js") && final_url.path() != target.path())
    {
        return Err("发布页或发布脚本跳转到了非可信地址".into());
    }
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PUBLISH_BYTES as u64)
    {
        return Err("地址发布页或脚本超过 512 KiB 限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| crate::net::err_text(&error))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_PUBLISH_BYTES {
            return Err("地址发布页或脚本超过 512 KiB 限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "地址发布页或脚本不是有效 UTF-8".into())
}

fn script_src(page: &str, html: &str) -> Result<String, String> {
    let document = Document::from(html);
    for script in document.select("script[src]").iter() {
        if let Some(src) = script.attr("src") {
            if let Ok(url) = absolute(page, &src) {
                return Ok(url);
            }
        }
    }
    Err("地址发布页没有同源 publish.js 脚本".into())
}

fn absolute(base: &str, relative: &str) -> Result<String, String> {
    if relative.chars().any(char::is_control) {
        return Err("发布脚本地址含控制字符".into());
    }
    let base = url::Url::parse(base).map_err(|_| "发布页地址无效")?;
    let target = base.join(relative.trim()).map_err(|_| "发布脚本地址无效")?;
    if base.scheme() != "https"
        || target.scheme() != "https"
        || target.origin() != base.origin()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
        || target.path().rsplit('/').next() != Some("publish.js")
    {
        return Err("只接受发布页同源的 HTTPS publish.js".into());
    }
    Ok(target.to_string())
}

/// Persisted lines gain credential trust only after a publisher confirms them.
/// Anonymous probes must not call this function.
pub async fn verify_published_origin(origin: &str) -> Result<(), String> {
    let origin = crate::net::normalize_base(origin).ok_or("线路必须是安全 HTTPS origin")?;
    if is_fixed(&origin) || is_trusted_mirror(&origin) {
        return Ok(());
    }
    if is_publisher_or_retired(&origin) {
        return Err("发布页不是业务线路，请选择主站或已发现的镜像".into());
    }
    let _ = discover(false, true).await?;
    if is_trusted_mirror(&origin) {
        Ok(())
    } else {
        Err("当前镜像未被本次运行的可信发布页确认；请刷新镜像后登录".into())
    }
}

#[derive(Debug, PartialEq)]
enum JsToken<'a> {
    Ident(&'a str),
    Quoted(&'a str),
    Symbol(u8),
    Other,
}

/// A conservative lexer: comments, strings, templates and regular expressions
/// cannot introduce declarations. No remote JavaScript is ever evaluated.
fn js_tokens(source: &str) -> Result<Vec<JsToken<'_>>, String> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte.is_ascii_whitespace() {
            at += 1;
            continue;
        }
        if bytes[at..].starts_with(b"//") {
            at += 2;
            while at < bytes.len() && bytes[at] != 10 {
                at += 1;
            }
            continue;
        }
        if bytes[at..].starts_with(b"/*") {
            at += 2;
            let Some(end) = source[at..].find("*/") else {
                return Err("发布脚本注释未闭合".into());
            };
            at += end + 2;
            continue;
        }
        if matches!(byte, 39 | 34 | 96) {
            let start = at;
            at += 1;
            while at < bytes.len() && bytes[at] != byte {
                if bytes[at] == 92 {
                    at += 1;
                }
                at += 1;
            }
            if at >= bytes.len() {
                return Err("发布脚本字符串未闭合".into());
            }
            at += 1;
            out.push(if byte == 96 {
                JsToken::Other
            } else {
                JsToken::Quoted(&source[start..at])
            });
            continue;
        }
        // Division is deliberately treated as a regex as well. Publisher data
        // requires no arithmetic; ambiguous input therefore fails closed.
        if byte == b'/' {
            at += 1;
            let mut in_class = false;
            while at < bytes.len() {
                match bytes[at] {
                    92 => {
                        at += 2;
                        continue;
                    }
                    b'[' => in_class = true,
                    b']' => in_class = false,
                    b'/' if !in_class => break,
                    10 | 13 => return Err("发布脚本包含不支持的表达式".into()),
                    _ => {}
                }
                at += 1;
            }
            if at >= bytes.len() {
                return Err("发布脚本表达式未闭合".into());
            }
            at += 1;
            while at < bytes.len() && bytes[at].is_ascii_alphabetic() {
                at += 1;
            }
            out.push(JsToken::Other);
            continue;
        }
        if byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$') {
            let start = at;
            at += 1;
            while at < bytes.len()
                && (bytes[at].is_ascii_alphanumeric() || matches!(bytes[at], b'_' | b'$'))
            {
                at += 1;
            }
            out.push(JsToken::Ident(&source[start..at]));
        } else {
            out.push(JsToken::Symbol(byte));
            at += 1;
        }
    }
    Ok(out)
}

fn js_string(raw: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut chars = raw[1..raw.len() - 1].chars();
    while let Some(ch) = chars.next() {
        if ch != char::from(92) {
            if ch.is_control() {
                return Err("镜像字符串含控制字符".into());
            }
            result.push(ch);
            continue;
        }
        match chars.next() {
            Some(ch) if matches!(ch as u32, 92 | 39 | 34 | 47) => result.push(ch),
            Some('x') => {
                let code: String = chars.by_ref().take(2).collect();
                let byte = u8::from_str_radix(&code, 16)
                    .ok()
                    .filter(|_| code.len() == 2)
                    .ok_or("镜像字符串转义无效")?;
                result.push(char::from(byte));
            }
            Some('u') => {
                let code: String = chars.by_ref().take(4).collect();
                let number = u32::from_str_radix(&code, 16)
                    .ok()
                    .filter(|_| code.len() == 4)
                    .ok_or("镜像字符串转义无效")?;
                result.push(char::from_u32(number).ok_or("镜像字符串转义无效")?);
            }
            _ => return Err("镜像字符串含不支持的转义".into()),
        }
    }
    Ok(result)
}

/// Only literal top-level var/let/const arrays are accepted. Malformed
/// subdomains must not fall back to trusting the bare domains.
fn js_array(source: &str, name: &str) -> Result<Option<Vec<String>>, String> {
    let tokens = js_tokens(source)?;
    let mut depth = 0usize;
    let mut result = None;
    for (at, token) in tokens.iter().enumerate() {
        let declaration = matches!(token, JsToken::Ident("var" | "let" | "const"));
        if depth == 0 && declaration && tokens.get(at + 1) == Some(&JsToken::Ident(name)) {
            if result.is_some() {
                return Err(format!("发布脚本重复声明 {name}"));
            }
            if tokens.get(at + 2) != Some(&JsToken::Symbol(b'='))
                || tokens.get(at + 3) != Some(&JsToken::Symbol(b'['))
            {
                return Err(format!("发布脚本的 {name} 必须是字符串数组"));
            }
            let mut cursor = at + 4;
            let mut values = Vec::new();
            while tokens.get(cursor) != Some(&JsToken::Symbol(b']')) {
                let Some(JsToken::Quoted(raw)) = tokens.get(cursor) else {
                    return Err(format!("发布脚本的 {name} 含非字符串值"));
                };
                if values.len() >= PUBLISH_ARRAY_MAX {
                    return Err(format!("{name} exceeds the publisher array size limit"));
                }
                values.push(js_string(raw)?);
                cursor += 1;
                match tokens.get(cursor) {
                    Some(JsToken::Symbol(b',')) => cursor += 1,
                    Some(JsToken::Symbol(b']')) => {}
                    _ => return Err(format!("发布脚本的 {name} 数组格式无效")),
                }
            }
            if !matches!(tokens.get(cursor + 1), None | Some(JsToken::Symbol(b';'))) {
                return Err(format!("发布脚本的 {name} 不能使用动态表达式"));
            }
            result = Some(values);
        }
        match token {
            JsToken::Symbol(b'{' | b'(' | b'[') => depth += 1,
            JsToken::Symbol(b'}' | b')' | b']') => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(result)
}

/// Validate the unwrapped /api/videos data, rather than HTML or status alone.
pub(crate) fn healthy_video_data(data: &Value) -> bool {
    let Some(items) = data.get("items").and_then(Value::as_array) else {
        return false;
    };
    let Some(pagination) = data.get("pagination").and_then(Value::as_object) else {
        return false;
    };
    let integer = |key: &str| pagination.get(key).and_then(Value::as_u64);
    if integer("page").is_none_or(|n| n == 0)
        || integer("size").is_none_or(|n| n == 0)
        || integer("pages").is_none()
        || integer("total").is_none()
    {
        return false;
    }
    // These two fields are stable feed identity, unlike optional cover/score.
    items.iter().all(|item| {
        item.get("id")
            .and_then(Value::as_u64)
            .is_some_and(|id| id > 0)
            && item
                .get("title")
                .and_then(Value::as_str)
                .is_some_and(|title| !title.trim().is_empty())
    })
}

#[derive(Clone)]
pub struct Hit {
    pub tier: &'static str,
    pub url: String,
    pub ok: bool,
    pub reachable: bool,
    pub ms: u64,
    pub status: Option<u16>,
    error: Option<String>,
}

impl Hit {
    fn json(&self) -> Value {
        let mut value = json!({ "tier": self.tier, "url": self.url, "ok": self.ok,
            "reachable": self.reachable, "ms": self.ms, "status": self.status });
        if let Some(error) = &self.error {
            value["error"] = json!(error);
        }
        value
    }
}

async fn probe_hit(tier: &'static str, raw: &str) -> Hit {
    let mut hit = Hit {
        tier,
        url: raw.to_owned(),
        ok: false,
        reachable: false,
        ms: 0,
        status: None,
        error: None,
    };
    let Some(origin) = crate::net::normalize_base(raw) else {
        hit.error = Some("线路必须是安全 HTTPS origin".into());
        return hit;
    };
    hit.url = origin.clone();
    if is_publisher_or_retired(&origin) {
        hit.error = Some("发布页不是业务线路".into());
        return hit;
    }
    // Manual checks, current-line checks and automatic races share this cap.
    let Ok(_slot) = PROBE_SLOTS.acquire().await else {
        hit.error = Some("线路探测已停止".into());
        return hit;
    };
    let started = Instant::now();
    // edge sends the upstream's real envelope. None explicitly omits credentials.
    // This total deadline also covers edge retries and the response body.
    match tokio::time::timeout(
        AUTO_PROBE_TIMEOUT,
        crate::net::edge(&origin, "GET", AUTO_PROBE_PATH, None, None),
    )
    .await
    {
        Ok(Ok(data)) => {
            hit.reachable = true;
            hit.status = Some(200);
            hit.ok = healthy_video_data(&data);
            if !hit.ok {
                hit.error = Some("接口未返回有效视频列表数据".into());
            }
        }
        Ok(Err(error)) => {
            hit.error = Some(error);
        }
        Err(_) => {
            hit.error = Some("视频接口探测超时（5 秒）".into());
        }
    }
    hit.ms = started.elapsed().as_millis() as u64;
    hit
}

/// Manual checks never change trust or the active line. Normalize and dedupe
/// before the cap; a rolling queue keeps at most four probes in flight.
pub async fn probe(urls: Vec<String>) -> Value {
    let mut seen = HashSet::new();
    let mut queue: VecDeque<_> = urls.into_iter().filter_map(|url| crate::net::normalize_base(&url))
        .filter(|url| !is_publisher_or_retired(url) && seen.insert(url.clone()))
        .take(MIRROR_MAX).collect();
    let mut tasks = tokio::task::JoinSet::new();
    let mut out = Vec::new();
    loop {
        while tasks.len() < PROBE_CONCURRENCY {
            let Some(origin) = queue.pop_front() else { break };
            tasks.spawn(async move { probe_hit("mirror", &origin).await });
        }
        let Some(result) = tasks.join_next().await else { break };
        if let Ok(hit) = result { out.push(hit.json()); }
    }
    json!(out)
}

/// Probe different publisher roots before more aliases of the same root. Rotate
/// both roots and aliases between attempts, so a 12-probe budget cannot starve
/// entries at the end of the published pool forever.
fn ordered_mirrors(items: &[Mirror], rotation: usize) -> Vec<(String, String)> {
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let Some(origin) = crate::net::normalize_base(&item.url) else { continue };
        if is_fixed(&origin) || is_publisher_or_retired(&origin) || !seen.insert(origin.clone()) { continue; }
        if let Some((_, origins)) = groups.iter_mut().find(|(root, _)| root == &item.root) {
            origins.push(origin);
        } else {
            groups.push((item.root.clone(), vec![origin]));
        }
    }
    if groups.is_empty() { return Vec::new(); }
    let count = groups.len();
    groups.rotate_left(rotation % count);
    for (_, origins) in &mut groups {
        let count = origins.len();
        origins.rotate_left(rotation % count);
    }
    let mut out = Vec::new();
    for round in 0..PER_ROOT_MAX {
        for (root, origins) in &groups {
            if let Some(origin) = origins.get(round) { out.push((origin.clone(), root.clone())); }
        }
    }
    out
}

fn selection_result(hits: &[Hit], kept: bool, stale: bool, error: Option<&str>) -> Value {
    let winner = hits.iter().find(|hit| hit.ok);
    let candidates: Vec<_> = hits.iter().map(Hit::json).collect();
    let mut result = match winner {
        Some(hit) => json!({ "base": hit.url, "tier": hit.tier, "ms": hit.ms,
            "reason": if kept { "kept-current" } else if hit.tier == "main" { "main-ok" } else { "mirror-ok" },
            "candidates": candidates }),
        None => json!({ "base": "", "tier": "none", "ms": 0, "reason": "all-down", "candidates": candidates }),
    };
    result["stale"] = json!(stale);
    if let Some(error) = error { result["discovery_error"] = json!(error); }
    result
}

fn next_candidate(
    queue: &mut VecDeque<(String, String)>,
    attempted: &mut HashSet<String>,
    root_counts: &mut std::collections::HashMap<String, usize>,
    remaining: &mut usize,
) -> Option<String> {
    while *remaining > 0 {
        let (origin, root) = queue.pop_front()?;
        if attempted.contains(&origin) || *root_counts.get(&root).unwrap_or(&0) >= PER_ROOT_MAX { continue; }
        attempted.insert(origin.clone());
        *root_counts.entry(root).or_default() += 1;
        *remaining -= 1;
        return Some(origin);
    }
    None
}

enum SelectionEvent {
    Probe(Hit),
    Discovery(Result<Discovery, String>),
}

/// Keep a healthy current origin. Only a confirmed failure starts discovery and
/// races the main origin with mirrors; recovering .com never preempts playback.
pub async fn auto_pick() -> Value {
    let current = crate::net::base();
    let mut hits = Vec::new();
    let mut attempted = HashSet::new();
    if !is_publisher_or_retired(&current) {
        let tier = if is_fixed(&current) { "main" } else if crate::net::is_custom_line() { "custom" } else { "mirror" };
        let hit = probe_hit(tier, &current).await;
        let healthy = hit.ok;
        attempted.insert(current.clone());
        hits.push(hit);
        if healthy { return selection_result(&hits, true, false, None); }
    }
    let rotation = CANDIDATE_ROTATION.fetch_add(1, Ordering::Relaxed);
    let cached = source_cache::cached();
    let needs_refresh = cached.as_ref().is_none_or(|snapshot| !snapshot.fresh(source_cache::now()));
    let mut stale = cached.as_ref().is_some_and(|snapshot| !snapshot.fresh(source_cache::now()));
    let mut discovery_error = source_cache::recent_error();
    stale |= cached.is_some() && discovery_error.is_some();
    let mut root_counts = std::collections::HashMap::new();
    if let Some(item) = cached.as_ref().and_then(|snapshot| snapshot.items.iter().find(|item| item.url == current)) {
        root_counts.insert(item.root.clone(), 1);
    }
    let mut remaining = AUTO_MIRROR_MAX.saturating_sub(attempted.len());
    let mut queue = VecDeque::from([(FIXED[0].1.to_owned(), "main".to_owned())]);
    if let Some(snapshot) = &cached { queue.extend(ordered_mirrors(&snapshot.items, rotation)); }

    // Discovery and probes share one event loop: a fresh publisher result can
    // fill free probe slots immediately, even while the main request is slow.
    // Dropping JoinSet on the first healthy endpoint cancels all remaining work.
    let mut tasks = tokio::task::JoinSet::new();
    let mut probing = 0_usize;
    let mut refreshed = needs_refresh;
    if needs_refresh {
        tasks.spawn(async { SelectionEvent::Discovery(discover(false, false).await) });
    }
    loop {
        while probing < PROBE_CONCURRENCY {
            let Some(origin) = next_candidate(&mut queue, &mut attempted, &mut root_counts, &mut remaining) else { break };
            tasks.spawn(async move { SelectionEvent::Probe(probe_hit(if is_fixed(&origin) { "main" } else { "mirror" }, &origin).await) });
            probing += 1;
        }
        if tasks.is_empty() {
            // A fresh cached pool that fails gets one forced refresh, retaining
            // the original per-root and total budgets and all attempted URLs.
            if !refreshed && remaining > 0 {
                refreshed = true;
                tasks.spawn(async { SelectionEvent::Discovery(discover(true, false).await) });
            } else {
                break;
            }
        }
        let Some(event) = tasks.join_next().await else { break };
        match event {
            Ok(SelectionEvent::Probe(mut hit)) => {
                probing = probing.saturating_sub(1);
                // A concurrent successful publication can remove an older hint.
                // Do not return an endpoint that apply_base would now reject.
                if hit.ok && !is_fixed(&hit.url) && !is_known_mirror(&hit.url) {
                    hit.ok = false;
                    hit.error = Some("镜像已不在最新有效发布列表中".into());
                }
                let healthy = hit.ok;
                hits.push(hit);
                if healthy { return selection_result(&hits, false, stale, discovery_error.as_deref()); }
            }
            Ok(SelectionEvent::Discovery(Ok(entry))) => {
                stale = entry.stale;
                discovery_error = entry.error;
                // If this origin came only from line.json, its root becomes
                // known at discovery time; its failed current probe still counts.
                if let Some(item) = entry.snapshot.items.iter().find(|item| item.url == current) {
                    root_counts.entry(item.root.clone()).or_insert(1);
                }
                queue = ordered_mirrors(&entry.snapshot.items, rotation).into();
            }
            Ok(SelectionEvent::Discovery(Err(error))) => discovery_error = Some(error),
            Err(_) => {
                // Panicking probe tasks must not permanently consume a slot.
                probing = probing.saturating_sub(1);
            }
        }
    }
    selection_result(&hits, false, stale, discovery_error.as_deref())
}

pub async fn try_main() -> Value {
    let hit = probe_hit("main", FIXED[0].1).await;
    let mut result = hit.json();
    result["base"] = json!(hit.url);
    result
}

pub async fn health() -> Value {
    let hit = probe_hit("current", &crate::net::base()).await;
    let mut result = hit.json();
    result["base"] = json!(hit.url);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origins(items: &[Value]) -> Vec<&str> {
        items
            .iter()
            .filter_map(|item| item["url"].as_str())
            .collect()
    }

    #[test]
    fn literal_arrays_support_comments_quotes_and_trailing_commas() {
        let js = r#"/* before */ var urls = ['EXAMPLE.COM/', "two.example",];
          const subdomains = [ 'one', // line comment
          'two', ]; var untouched = 'https://example.com/';"#;
        let items = parse_mirrors(js).unwrap();
        assert_eq!(
            origins(&items),
            [
                "https://one.example.com",
                "https://one.two.example",
                "https://two.example.com",
                "https://two.two.example"
            ]
        );
        assert_eq!(
            js_array("let urls = ['https://host/'];", "urls")
                .unwrap()
                .unwrap(),
            ["https://host/"]
        );
    }

    #[test]
    fn fake_declarations_in_comments_strings_templates_and_regex_are_ignored() {
        for js in [
            r#"// var urls=['bad.example'];"#,
            r#"/* var urls=['bad.example']; */"#,
            r#"const text = "var urls=['bad.example'];";"#,
            r#"const text = `var urls=['bad.example'];`;"#,
            r#"const regex = /var urls=['bad.example'];/;"#,
            r#"var urlsExtra=['bad.example'];"#,
            r#"function notRun() { var urls=['bad.example']; }"#,
        ] {
            assert!(parse_mirrors(js).is_err(), "{js}");
        }
    }

    #[test]
    fn dynamic_or_malformed_arrays_fail_closed_including_subdomains() {
        for js in [
            r#"var urls=['one.example', getHost()];"#,
            r#"var urls=['one.example' + '.evil'];"#,
            r#"var urls=['one.example'].concat(other);"#,
            r#"var urls=['one.example']; var urls=['two.example'];"#,
            r#"var urls=['one.example']; var subdomains=getSubs();"#,
            r#"var urls=['one.example']; var subdomains=['one', 2];"#,
            r#"var urls=['one.example']; /* unfinished"#,
        ] {
            assert!(parse_mirrors(js).is_err(), "{js}");
        }
    }

    #[test]
    fn hostnames_are_canonical_bounded_and_not_paths_or_literal_ips() {
        let items = parse_mirrors(r#"var urls=['Example.COM', 'example.com/', '127.0.0.1', 'localhost', 'x.local', 'x.internal', 'x.home.arpa', 'https://evil.example', 'evil.example/path', 'a.example:443', '-a.example', 'valid.example'];"#).unwrap();
        assert_eq!(
            origins(&items),
            ["https://example.com", "https://valid.example"]
        );
        let js = format!(
            "var urls=[{}];",
            (0..100)
                .map(|n| format!("'host{n}.example'"))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert_eq!(parse_mirrors(&js).unwrap().len(), MIRROR_MAX);
    }

    #[test]
    fn publish_script_is_same_origin_and_exact_filename() {
        let page = PUBLISH_PAGES[0];
        for html in [
            "<script src='publish.js?v=2'></script>",
            "<script src=publish.js></script>",
            r#"<script src='/analytics.js'></script><script src="/publish.js"></script>"#,
        ] {
            let script = script_src(page, html).unwrap();
            assert!(script.starts_with("https://huang-guo.pages.dev/publish.js"));
        }
        for target in [
            "http://huangguoai.pages.dev/publish.js",
            "https://other.example/publish.js",
            "//other.example/publish.js",
            "javascript:publish.js",
            "https://user@huangguoai.pages.dev/publish.js",
            "/publish.js#fragment",
            "/publish.js/extra",
            "/publish.js.evil",
        ] {
            assert!(absolute(page, target).is_err(), "{target}");
        }
        assert!(script_src(page, "<script src='analytics.js'></script>").is_err());
    }

    fn page(source: &str) -> PublishedPage {
        PublishedPage { source: source.into(), script: format!("{source}publish.js"),
            items: vec![json!({"url": "https://mirror.example", "host": "mirror.example", "root": "mirror.example"})] }
    }

    #[tokio::test]
    async fn first_publisher_does_not_wait_for_blocked_primary_or_secondary() {
        let winner = first_publisher(std::future::pending(), async { Ok(page(PUBLISH_PAGES[1])) }, Duration::ZERO).await.unwrap();
        assert_eq!(winner.source, PUBLISH_PAGES[1]);
        let winner = first_publisher(async { Ok(page(PUBLISH_PAGES[0])) }, std::future::pending(), PUBLISH_HEDGE).await.unwrap();
        assert_eq!(winner.source, PUBLISH_PAGES[0]);
        let winner = first_publisher(async { Err("primary down".into()) }, async { Ok(page(PUBLISH_PAGES[1])) }, PUBLISH_HEDGE).await.unwrap();
        assert_eq!(winner.source, PUBLISH_PAGES[1]);
        assert!(first_publisher(async { Err("first".into()) }, async { Err("second".into()) }, Duration::ZERO).await.is_err());
    }

    #[test]
    fn health_requires_real_unwrapped_feed_data() {
        let valid = json!({"items": [{"id": 12, "title": "video"}], "pagination": {"page": 1, "pages": 2, "size": 1, "total": 2}});
        assert!(healthy_video_data(&valid));
        assert!(healthy_video_data(
            &json!({"items": [], "pagination": {"page": 1, "pages": 0, "size": 1, "total": 0}})
        ));
        for invalid in [
            Value::Null,
            json!("<html>200 OK</html>"),
            json!({}),
            json!({"status": 0, "msg": "denied"}),
            json!({"status": 1, "data": valid}),
            json!({"items": []}),
            json!({"items": [{}], "pagination": {"page": 1, "pages": 1, "size": 1, "total": 1}}),
        ] {
            assert!(!healthy_video_data(&invalid), "{invalid}");
        }
    }

    fn hit(url: &str, ok: bool, ms: u64) -> Hit {
        Hit {
            tier: "mirror",
            url: url.into(),
            ok,
            reachable: true,
            ms,
            status: Some(200),
            error: None,
        }
    }

    #[test]
    fn all_down_never_returns_a_line_to_switch_to() {
        for hits in [vec![], vec![hit("https://bad.example", false, 1)]] {
            let selected = selection_result(&hits, false, true, Some("publisher offline"));
            assert_eq!(selected["reason"], "all-down");
            assert_eq!(selected["base"], "");
            assert_eq!(selected["tier"], "none");
        }
        let selected = selection_result(&[
            hit("https://html.example", false, 1),
            hit("https://slow.example", true, 20),
            hit("https://fast.example", true, 8),
        ], false, false, None);
        assert_eq!(selected["base"], "https://slow.example");
    }

    #[test]
    fn parser_and_candidates_exclude_publishers_retired_and_duplicate_endpoints() {
        let items = parse_mirrors("var urls=['huangguoai.ai','huangguo.ai','huang-guo.pages.dev','huangguoai.pages.dev','huangguoai.com','mirror.example','mirror.example'];").unwrap();
        assert_eq!(origins(&items), ["https://mirror.example"]);
        let subdomains = parse_mirrors("var urls=['huangguoai.ai','huang-guo.pages.dev','mirror.example']; var subdomains=['one'];").unwrap();
        assert_eq!(origins(&subdomains), ["https://one.mirror.example"]);
        assert_eq!(FIXED.len(), 1);
        assert!(!is_fixed("https://huangguoai.ai"));
    }

    #[test]
    fn root_round_robin_and_rotation_reach_the_rest_of_the_pool() {
        let items = parse_mirrors("var urls=['a.example','b.example']; var subdomains=['one','two','three','four'];").unwrap();
        assert_eq!(&origins(&items)[..4], ["https://one.a.example", "https://one.b.example", "https://two.a.example", "https://two.b.example"]);
        let mirrors: Vec<Mirror> = items.into_iter().map(|item| serde_json::from_value(item).unwrap()).collect();
        let first = ordered_mirrors(&mirrors, 0);
        assert_eq!(first.len(), 6);
        assert!(first.chunks(2).all(|pair| pair[0].1 != pair[1].1));
        let later = ordered_mirrors(&mirrors, 3);
        assert!(later.iter().any(|(origin, _)| origin == "https://four.a.example"));
        assert!(!first.iter().any(|(origin, _)| origin == "https://four.a.example"));
    }

    #[test]
    fn healthy_current_is_kept_even_when_another_hit_is_faster() {
        let mut current = hit("https://current.example", true, 120);
        current.tier = "mirror";
        let result = selection_result(&[current, hit("https://fast.example", true, 8)], true, false, None);
        assert_eq!(result["base"], "https://current.example");
        assert_eq!(result["reason"], "kept-current");
    }

    #[test]
    fn candidate_budget_deduplicates_and_advances_past_exhausted_roots() {
        let mut queue: VecDeque<_> = (0..8).map(|index| (format!("https://a{index}.example"), "a.example".to_owned()))
            .chain((0..8).map(|index| (format!("https://b{index}.example"), "b.example".to_owned()))).collect();
        queue.push_front(("https://already.example".into(), "a.example".into()));
        let mut attempted = HashSet::from(["https://already.example".into()]);
        let mut roots = std::collections::HashMap::new();
        let mut remaining = 5;
        let mut selected = Vec::new();
        while let Some(origin) = next_candidate(&mut queue, &mut attempted, &mut roots, &mut remaining) {
            selected.push(origin);
        }
        assert_eq!(selected.len(), 5);
        assert_eq!(roots["a.example"], PER_ROOT_MAX);
        assert_eq!(roots["b.example"], 2);
        assert_eq!(remaining, 0);
        assert!(selected.iter().any(|origin| origin == "https://b0.example"));
    }

    #[test]
    fn stale_discovery_schema_retains_items_and_reports_error_without_trust() {
        let entry = Discovery {
            snapshot: Snapshot { source: PUBLISH_PAGES[0].into(), script: format!("{}publish.js", PUBLISH_PAGES[0]), fetched_at: 123,
                items: vec![Mirror { url: "https://mirror.example".into(), host: "mirror.example".into(), root: "mirror.example".into() }] },
            stale: true,
            error: Some("publisher unavailable".into()),
        };
        let value = entry.json();
        assert_eq!(value["updated_at"], 123000);
        assert_eq!(value["stale"], true);
        assert_eq!(value["items"][0]["url"], "https://mirror.example");
        assert_eq!(value["errors"], json!(["publisher unavailable"]));
        assert_eq!(value["discovery_error"], "publisher unavailable");
        let result = selection_result(&[], false, true, Some("publisher unavailable"));
        assert_eq!(result["base"], "");
        assert_eq!(result["reason"], "all-down");
        assert_eq!(result["stale"], true);
        assert_eq!(result["discovery_error"], "publisher unavailable");
    }
}
