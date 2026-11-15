//! 把当前正在播的这一集保存到本机。
//!
//! 播放地址经常是 HLS。这里跟着主清单选一条清晰度，按顺序拉取分片，
//! AES-128 的分片先解密。H.264 + AAC 的 TS 重封装成 `.mp4`（不重新编码），
//! 其它编码仍保存为 `.ts`。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::net::fetch_bytes;

static BUSY: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[derive(Clone, Serialize)]
struct Progress {
    key: String,
    done: usize,
    total: usize,
}

struct BusyGuard {
    key: String,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        let mut busy = BUSY.lock().unwrap_or_else(|err| err.into_inner());
        busy.retain(|item| item != &self.key);
    }
}

#[tauri::command]
pub async fn download_media(
    app: AppHandle,
    url: String,
    name: String,
    key: String,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("没有可下载的视频地址".into());
    }
    let key = if key.trim().is_empty() { url.clone() } else { key };
    {
        let mut busy = BUSY.lock().unwrap_or_else(|err| err.into_inner());
        if busy.iter().any(|item| item == &key) {
            return Err("这一集正在下载".into());
        }
        busy.push(key.clone());
    }
    let _guard = BusyGuard { key: key.clone() };
    let dir = save_dir(&app)?;
    let stem = safe_name(&name);
    let saved = save_episode(&app, &key, &url, &dir, &stem).await?;
    Ok(saved.display().to_string())
}

fn save_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = {
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            app.path().document_dir()
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            app.path().download_dir().or_else(|_| app.path().document_dir())
        }
    }
    .or_else(|_| app.path().app_data_dir())
    .map_err(|err| format!("找不到保存位置: {err}"))?;
    let dir = if cfg!(any(target_os = "ios", target_os = "android")) {
        base.join("HGhubX")
    } else {
        base
    };
    fs::create_dir_all(&dir).map_err(|err| format!("创建下载目录失败: {err}"))?;
    Ok(dir)
}

async fn save_episode(
    app: &AppHandle,
    key: &str,
    url: &str,
    dir: &Path,
    stem: &str,
) -> Result<PathBuf, String> {
    let (bytes, ext) = collect(app, key, url, 0).await?;
    let (bytes, ext) = if ext == "ts" {
        match crate::ts_mp4::remux_ts(&bytes) {
            Ok(mp4) => (mp4, "mp4"),
            Err(reason) => {
                eprintln!("ts remux skipped: {reason}");
                (bytes, "ts")
            }
        }
    } else {
        (bytes, ext)
    };
    let path = dir.join(format!("{stem}.{ext}"));
    let temp = dir.join(format!("{stem}.{ext}.part"));
    {
        let mut file = File::create(&temp).map_err(|err| format!("无法写入文件: {err}"))?;
        file.write_all(&bytes).map_err(|err| format!("写入中断: {err}"))?;
        file.flush().map_err(|err| format!("写入中断: {err}"))?;
    }
    fs::rename(&temp, &path).map_err(|err| format!("保存失败: {err}"))?;
    Ok(path)
}

async fn collect(app: &AppHandle, key: &str, url: &str, depth: u8) -> Result<(Vec<u8>, &'static str), String> {
    if depth > 3 {
        return Err("播放列表嵌套太深".into());
    }
    let (ctype, bytes) = fetch_bytes(url).await?;
    let text = std::str::from_utf8(&bytes).ok();
    let playlist = text
        .map(|raw| raw.trim_start_matches('\u{feff}').trim_start().starts_with("#EXTM3U"))
        .unwrap_or(false)
        || ctype.as_deref().unwrap_or("").to_ascii_lowercase().contains("mpegurl")
        || url.split('?').next().unwrap_or(url).to_ascii_lowercase().ends_with(".m3u8");
    if !playlist {
        let ext = if url.split('?').next().unwrap_or(url).to_ascii_lowercase().contains(".mp4") {
            "mp4"
        } else {
            "ts"
        };
        emit(app, key, 1, 1);
        return Ok((bytes, ext));
    }
    let text = text.ok_or("播放列表不是文本")?.trim_start_matches('\u{feff}');
    if text.contains("#EXT-X-STREAM-INF:") {
        let variant = pick_variant(url, text).ok_or("播放列表里没有可下载的清晰度")?;
        return Box::pin(collect(app, key, &variant, depth + 1)).await;
    }
    download_media_playlist(app, key, url, text).await
}

async fn download_media_playlist(
    app: &AppHandle,
    key: &str,
    base: &str,
    text: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    if text.contains("#EXT-X-BYTERANGE:") {
        return Err("这个分片带字节范围，暂时不能整段保存".into());
    }
    let mut sequence = media_sequence(text);
    let mut key_state: Option<AesKey> = None;
    let mut map_url: Option<String> = None;
    let mut segments: Vec<(String, u64)> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXT-X-KEY:") {
            key_state = parse_key(base, line).await?;
            continue;
        }
        if line.starts_with("#EXT-X-MAP:") {
            let uri = quoted_attr(line, "URI").ok_or("初始化片段缺少地址")?;
            map_url = Some(absolutize(base, &uri));
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        segments.push((absolutize(base, line), sequence));
        sequence = sequence.saturating_add(1);
    }
    if segments.is_empty() {
        return Err("播放列表里没有分片".into());
    }
    let ext = if map_url.is_some()
        || segments.iter().any(|(url, _)| {
            let path = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
            path.ends_with(".m4s") || path.ends_with(".mp4") || path.ends_with(".m4v")
        }) {
        "mp4"
    } else {
        "ts"
    };
    let total = segments.len() + usize::from(map_url.is_some());
    let mut out = Vec::new();
    let mut done = 0usize;
    if let Some(url) = map_url {
        let (_, bytes) = fetch_bytes(&url).await?;
        out.extend_from_slice(&bytes);
        done += 1;
        emit(app, key, done, total);
    }
    for (url, seq) in segments {
        let (_, bytes) = fetch_bytes(&url).await?;
        let plain = match &key_state {
            Some(key) => decrypt_segment(key, seq, &bytes)?,
            None => bytes,
        };
        out.extend_from_slice(&plain);
        done += 1;
        emit(app, key, done, total);
    }
    Ok((out, ext))
}

struct AesKey {
    key: [u8; 16],
    iv: Option<[u8; 16]>,
}

async fn parse_key(base: &str, line: &str) -> Result<Option<AesKey>, String> {
    let method = quoted_or_plain(line, "METHOD").unwrap_or_default();
    if method.eq_ignore_ascii_case("NONE") {
        return Ok(None);
    }
    if !method.eq_ignore_ascii_case("AES-128") {
        return Err("这种加密方式暂时不能下载".into());
    }
    let uri = quoted_attr(line, "URI").ok_or("缺少解密密钥地址")?;
    let (_, bytes) = fetch_bytes(&absolutize(base, &uri)).await?;
    if bytes.len() != 16 {
        return Err("解密密钥长度不对".into());
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(&bytes);
    Ok(Some(AesKey { key, iv: parse_iv(line) }))
}

fn decrypt_segment(key: &AesKey, sequence: u64, data: &[u8]) -> Result<Vec<u8>, String> {
    if data.is_empty() || data.len() % 16 != 0 {
        return Err("加密分片长度无效".into());
    }
    let iv = key.iv.unwrap_or_else(|| sequence_iv(sequence));
    let cipher = Aes128::new_from_slice(&key.key).map_err(|_| "解密密钥无效")?;
    let mut prev = iv;
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut block = [0u8; 16];
        block.copy_from_slice(chunk);
        let cipher_text = block;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = cipher_text;
    }
    let pad = *out.last().unwrap_or(&0) as usize;
    if pad == 0 || pad > 16 || out.len() < pad || out[out.len() - pad..].iter().any(|b| *b as usize != pad) {
        return Err("解密结果无效".into());
    }
    out.truncate(out.len() - pad);
    Ok(out)
}

fn sequence_iv(sequence: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..].copy_from_slice(&sequence.to_be_bytes());
    iv
}

fn parse_iv(line: &str) -> Option<[u8; 16]> {
    let raw = quoted_or_plain(line, "IV")?;
    let hex = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X"))?;
    if hex.len() != 32 {
        return None;
    }
    let mut iv = [0u8; 16];
    for (i, byte) in iv.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(iv)
}

fn media_sequence(text: &str) -> u64 {
    text.lines()
        .find_map(|line| line.trim().strip_prefix("#EXT-X-MEDIA-SEQUENCE:"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

fn pick_variant(base: &str, text: &str) -> Option<String> {
    let mut best: Option<(u64, String)> = None;
    let mut bandwidth = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("#EXT-X-STREAM-INF:") {
            bandwidth = Some(quoted_or_plain(line, "BANDWIDTH").and_then(|v| v.parse().ok()).unwrap_or(0));
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(bw) = bandwidth.take() {
            let url = absolutize(base, line);
            if best.as_ref().map(|(score, _)| bw >= *score).unwrap_or(true) {
                best = Some((bw, url));
            }
        }
    }
    best.map(|(_, url)| url)
}

fn quoted_attr(line: &str, name: &str) -> Option<String> {
    let marker = format!("{name}=\"");
    let start = line.find(&marker)? + marker.len();
    let rest = line.get(start..)?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn quoted_or_plain(line: &str, name: &str) -> Option<String> {
    if let Some(value) = quoted_attr(line, name) {
        return Some(value);
    }
    let marker = format!("{name}=");
    let start = line.find(&marker)? + marker.len();
    let rest = line.get(start..)?;
    let end = rest.find([',', ' ', '\t']).unwrap_or(rest.len());
    Some(rest[..end].trim().to_string())
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    url::Url::parse(base)
        .ok()
        .and_then(|base| base.join(target).ok())
        .map(|url| url.to_string())
        .unwrap_or_else(|| target.to_string())
}

fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                ch
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(80).collect();
    if trimmed.is_empty() { "视频".into() } else { trimmed }
}

fn emit(app: &AppHandle, key: &str, done: usize, total: usize) {
    let _ = app.emit("download-progress", Progress { key: key.to_string(), done, total });
}

#[derive(Serialize)]
pub struct DownloadItem {
    id: String,
    name: String,
    bytes: u64,
    modified: i64,
}

/// 已保存的视频。只列下载目录里的成品文件，半成品 `.part` 不出现。
#[tauri::command]
pub fn list_downloads(app: AppHandle) -> Result<Vec<DownloadItem>, String> {
    let dir = save_dir(&app)?;
    let mut items = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|err| format!("读取下载目录失败: {err}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !file_id_ok(&name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) if meta.is_file() => meta,
            _ => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_secs() as i64)
            .unwrap_or(0);
        items.push(DownloadItem {
            id: name.clone(),
            name,
            bytes: meta.len(),
            modified,
        });
    }
    items.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    Ok(items)
}

#[tauri::command]
pub fn delete_download(app: AppHandle, id: String) -> Result<(), String> {
    let path = resolve_download(&save_dir(&app)?, &id)?;
    fs::remove_file(&path).map_err(|err| format!("删除失败: {err}"))
}

/// 手机弹出系统分享（可存到「文件」、隔空投送）；电脑则在文件夹里定位。
#[tauri::command]
pub async fn export_download(app: AppHandle, id: String) -> Result<(), String> {
    let path = resolve_download(&save_dir(&app)?, &id)?;
    #[cfg(target_os = "ios")]
    {
        let path = path.display().to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(present_ios_share(&path));
        })
        .map_err(|err| format!("无法打开分享: {err}"))?;
        return rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "分享没有弹出".to_string())?;
    }
    #[cfg(not(target_os = "ios"))]
    {
        use tauri_plugin_opener::OpenerExt;
        if app.opener().reveal_item_in_dir(&path).is_ok() {
            return Ok(());
        }
        app.opener()
            .open_path(path.display().to_string(), None::<&str>)
            .map_err(|err| format!("无法导出: {err}"))
    }
}

/// 本机回环地址，只给应用内播放器用。不把磁盘路径交给网页。
#[tauri::command]
pub fn play_download(app: AppHandle, id: String) -> Result<String, String> {
    let dir = save_dir(&app)?;
    let path = resolve_download(&dir, &id)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("文件名无法播放")?;
    let origin = ensure_player(&dir)?;
    let encoded = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    Ok(format!("{origin}/d/{encoded}"))
}

fn file_id_ok(id: &str) -> bool {
    if id.is_empty() || id.len() > 180 || id.starts_with('.') || id.ends_with(".part") {
        return false;
    }
    if id.contains(['/', '\\', '\0']) || id == "." || id == ".." {
        return false;
    }
    Path::new(id).components().count() == 1
}

fn resolve_download(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !file_id_ok(id) {
        return Err("文件不存在".into());
    }
    let dir = fs::canonicalize(dir).map_err(|err| format!("找不到下载目录: {err}"))?;
    let path = fs::canonicalize(dir.join(id)).map_err(|_| "文件不存在".to_string())?;
    if !path.starts_with(&dir) || !path.is_file() {
        return Err("文件不存在".into());
    }
    Ok(path)
}

enum ByteRange {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

fn parse_byte_range(header: &str, len: u64) -> ByteRange {
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return ByteRange::Full;
    };
    if spec.is_empty() || spec.contains(',') {
        return ByteRange::Full;
    }
    let Some((start_s, end_s)) = spec.split_once('-') else {
        return ByteRange::Full;
    };
    if len == 0 {
        return ByteRange::Full;
    }
    if start_s.is_empty() {
        let Ok(suffix) = end_s.parse::<u64>() else {
            return ByteRange::Full;
        };
        if suffix == 0 {
            return ByteRange::Full;
        }
        let take = suffix.min(len);
        return ByteRange::Partial { start: len - take, end: len - 1 };
    }
    let Ok(start) = start_s.parse::<u64>() else {
        return ByteRange::Full;
    };
    if start >= len {
        return ByteRange::Unsatisfiable;
    }
    let end = if end_s.is_empty() {
        len - 1
    } else {
        match end_s.parse::<u64>() {
            Ok(end) => end.min(len - 1),
            Err(_) => return ByteRange::Full,
        }
    };
    if end < start {
        ByteRange::Unsatisfiable
    } else {
        ByteRange::Partial { start, end }
    }
}

fn media_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "mp4" | "m4v" | "mov" => "video/mp4",
        "ts" => "video/mp2t",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

static PLAYER_ORIGIN: Mutex<Option<String>> = Mutex::new(None);
static PLAYER_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

fn ensure_player(dir: &Path) -> Result<String, String> {
    {
        let mut slot = PLAYER_DIR.lock().unwrap_or_else(|err| err.into_inner());
        *slot = Some(dir.to_path_buf());
    }
    let mut origin = PLAYER_ORIGIN.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(existing) = origin.clone() {
        return Ok(existing);
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|err| format!("播放端口绑定失败: {err}"))?;
    let port = listener.local_addr().map_err(|err| format!("播放端口读取失败: {err}"))?.port();
    let url = format!("http://127.0.0.1:{port}");
    *origin = Some(url.clone());
    drop(origin);
    std::thread::Builder::new()
        .name("download-player".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(sock) = conn else { continue };
                std::thread::spawn(move || {
                    let _ = serve_player(sock);
                });
            }
        })
        .map_err(|err| format!("播放服务启动失败: {err}"))?;
    Ok(url)
}

fn serve_player(mut sock: TcpStream) -> std::io::Result<()> {
    let _ = sock.set_read_timeout(Some(Duration::from_secs(8)));
    let _ = sock.set_write_timeout(Some(Duration::from_secs(60)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    let header_end = loop {
        let read = sock.read(&mut tmp)?;
        if read == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..read]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 16 * 1024 {
            return write_status(&mut sock, 400, "text/plain", None, b"headers too large");
        }
    };
    let head = match std::str::from_utf8(&buf[..header_end]) {
        Ok(text) => text,
        Err(_) => return write_status(&mut sock, 400, "text/plain", None, b"bad request"),
    };
    let mut lines = head.split("\r\n");
    let Some(request) = lines.next() else {
        return write_status(&mut sock, 400, "text/plain", None, b"bad request");
    };
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method == "OPTIONS" {
        return write_status(&mut sock, 204, "text/plain", None, b"");
    }
    if method != "GET" && method != "HEAD" {
        return write_status(&mut sock, 405, "text/plain", None, b"method not allowed");
    }
    let path = target.split('?').next().unwrap_or(target);
    let Some(encoded) = path.strip_prefix("/d/") else {
        return write_status(&mut sock, 404, "text/plain", None, b"not found");
    };
    if encoded.is_empty() || encoded.contains('/') {
        return write_status(&mut sock, 404, "text/plain", None, b"not found");
    }
    let decoded = percent_encoding::percent_decode_str(encoded).decode_utf8().unwrap_or_default();
    let dir = PLAYER_DIR.lock().unwrap_or_else(|err| err.into_inner()).clone();
    let Some(dir) = dir else {
        return write_status(&mut sock, 404, "text/plain", None, b"not found");
    };
    let Ok(file_path) = resolve_download(&dir, &decoded) else {
        return write_status(&mut sock, 404, "text/plain", None, b"not found");
    };
    let mut range = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.trim().eq_ignore_ascii_case("range") {
            range = Some(value.trim().to_string());
        }
    }
    let mut file = File::open(&file_path)?;
    let len = file.metadata()?.len();
    let kind = match range.as_deref() {
        Some(header) => parse_byte_range(header, len),
        None => ByteRange::Full,
    };
    let (status, start, end) = match kind {
        ByteRange::Full => (200, 0, len.saturating_sub(1)),
        ByteRange::Partial { start, end } => (206, start, end),
        ByteRange::Unsatisfiable => {
            let extra = format!("Content-Range: bytes */{len}\r\n");
            return write_status(&mut sock, 416, "text/plain", Some(&extra), b"");
        }
    };
    if len == 0 {
        return write_status(&mut sock, 200, media_type(&decoded), None, b"");
    }
    let count = end - start + 1;
    let name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("video");
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n",
        if status == 206 { "Partial Content" } else { "OK" },
        media_type(name),
    );
    if status == 206 {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    head.push_str("\r\n");
    sock.write_all(head.as_bytes())?;
    if method == "HEAD" {
        return sock.flush();
    }
    file.seek(SeekFrom::Start(start))?;
    let mut left = count;
    let mut chunk = [0u8; 64 * 1024];
    while left > 0 {
        let want = left.min(chunk.len() as u64) as usize;
        let read = file.read(&mut chunk[..want])?;
        if read == 0 {
            break;
        }
        sock.write_all(&chunk[..read])?;
        left -= read as u64;
    }
    sock.flush()
}

fn write_status(sock: &mut TcpStream, status: u16, ctype: &str, extra: Option<&str>, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        _ => "Error",
    };
    let extra = extra.unwrap_or("");
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccept-Ranges: bytes\r\nConnection: close\r\n{extra}\r\n",
        body.len()
    );
    sock.write_all(head.as_bytes())?;
    if !body.is_empty() {
        sock.write_all(body)?;
    }
    sock.flush()
}

#[cfg(target_os = "ios")]
fn present_ios_share(path: &str) -> Result<(), String> {
    use std::ffi::{c_char, c_void, CString};
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    unsafe {
        let msg0 = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>(objc_msgSend as *const ());
        let msg1 = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void>(objc_msgSend as *const ());
        let msg1_usize = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void>(objc_msgSend as *const ());
        let msg_usize = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize>(objc_msgSend as *const ());
        let msg_bool = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool>(objc_msgSend as *const ());
        let msg_bool_arg = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> bool>(objc_msgSend as *const ());
        let msg_str = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void>(objc_msgSend as *const ());
        let msg_init = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> *mut c_void>(objc_msgSend as *const ());
        let msg_present = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, bool, *mut c_void)>(objc_msgSend as *const ());
        let msg_void = std::mem::transmute::<_, unsafe extern "C" fn(*mut c_void, *mut c_void)>(objc_msgSend as *const ());

        let cls = |name: &[u8]| objc_getClass(name.as_ptr() as *const c_char);
        let sel = |name: &[u8]| sel_registerName(name.as_ptr() as *const c_char);
        let str_cls = cls(b"NSString\0");
        let url_cls = cls(b"NSURL\0");
        let array_cls = cls(b"NSArray\0");
        let activity_cls = cls(b"UIActivityViewController\0");
        let app_cls = cls(b"UIApplication\0");
        let scene_cls = cls(b"UIWindowScene\0");
        if str_cls.is_null() || url_cls.is_null() || array_cls.is_null() || activity_cls.is_null() || app_cls.is_null() {
            return Err("系统分享不可用".into());
        }
        let c_path = CString::new(path).map_err(|_| "路径无效")?;
        let ns_path = msg_str(str_cls, sel(b"stringWithUTF8String:\0"), c_path.as_ptr());
        let url = msg1(url_cls, sel(b"fileURLWithPath:\0"), ns_path);
        let items = msg1(array_cls, sel(b"arrayWithObject:\0"), url);
        let activity = msg_init(msg0(activity_cls, sel(b"alloc\0")), sel(b"initWithActivityItems:applicationActivities:\0"), items, std::ptr::null_mut());
        if activity.is_null() {
            return Err("无法创建分享面板".into());
        }
        let app = msg0(app_cls, sel(b"sharedApplication\0"));
        let scenes = msg0(app, sel(b"connectedScenes\0"));
        let scene_list = msg0(scenes, sel(b"allObjects\0"));
        let mut window: *mut c_void = std::ptr::null_mut();
        if !scene_list.is_null() && !scene_cls.is_null() {
            let count = msg_usize(scene_list, sel(b"count\0"));
            for i in 0..count {
                let scene = msg1_usize(scene_list, sel(b"objectAtIndex:\0"), i);
                if scene.is_null() || !msg_bool_arg(scene, sel(b"isKindOfClass:\0"), scene_cls) {
                    continue;
                }
                let windows = msg0(scene, sel(b"windows\0"));
                if windows.is_null() {
                    continue;
                }
                let n = msg_usize(windows, sel(b"count\0"));
                for j in 0..n {
                    let candidate = msg1_usize(windows, sel(b"objectAtIndex:\0"), j);
                    if candidate.is_null() {
                        continue;
                    }
                    if window.is_null() || msg_bool(candidate, sel(b"isKeyWindow\0")) {
                        window = candidate;
                    }
                }
            }
        }
        if window.is_null() {
            msg_void(activity, sel(b"release\0"));
            return Err("找不到可弹出分享的窗口".into());
        }
        let mut presenter = msg0(window, sel(b"rootViewController\0"));
        if presenter.is_null() {
            msg_void(activity, sel(b"release\0"));
            return Err("找不到可弹出分享的窗口".into());
        }
        loop {
            let next = msg0(presenter, sel(b"presentedViewController\0"));
            if next.is_null() {
                break;
            }
            presenter = next;
        }
        msg_present(presenter, sel(b"presentViewController:animated:completion:\0"), activity, true, std::ptr::null_mut());
        msg_void(activity, sel(b"release\0"));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncrypt;

    #[test]
    fn highest_bandwidth_variant_is_chosen() {
        let text = "\
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
high/index.m3u8
";
        assert_eq!(
            pick_variant("https://cdn.example/master.m3u8", text).as_deref(),
            Some("https://cdn.example/high/index.m3u8")
        );
    }

    #[test]
    fn aes_segment_roundtrip_uses_sequence_iv() {
        let key = AesKey { key: *b"0123456789abcdef", iv: None };
        let plain = b"segment-payload!!";
        let mut data = plain.to_vec();
        let pad = 16 - (data.len() % 16);
        data.extend(std::iter::repeat(pad as u8).take(pad));
        let cipher = Aes128::new_from_slice(&key.key).unwrap();
        let mut prev = sequence_iv(7);
        for chunk in data.chunks_mut(16) {
            for i in 0..16 {
                chunk[i] ^= prev[i];
            }
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            cipher.encrypt_block((&mut block).into());
            chunk.copy_from_slice(&block);
            prev = block;
        }
        let out = decrypt_segment(&key, 7, &data).unwrap();
        assert_eq!(out, plain);
    }

    #[test]
    fn unsafe_filename_characters_are_removed() {
        assert_eq!(safe_name("神瞳觉醒 / 第一季:第1集"), "神瞳觉醒 第一季 第1集");
        assert_eq!(safe_name("   "), "视频");
    }

    #[test]
    fn download_ids_reject_paths_outside_the_folder() {
        assert!(file_id_ok("神瞳觉醒 第1集.mp4"));
        assert!(!file_id_ok("../secret.mp4"));
        assert!(!file_id_ok("nested/clip.mp4"));
        assert!(!file_id_ok(".hidden.mp4"));
        assert!(!file_id_ok("clip.mp4.part"));
    }

    #[test]
    fn byte_ranges_cover_probe_and_suffix() {
        match parse_byte_range("bytes=0-3", 16) {
            ByteRange::Partial { start, end } => assert_eq!((start, end), (0, 3)),
            other => panic!("expected partial, got full={}", matches!(other, ByteRange::Full)),
        }
        match parse_byte_range("bytes=10-", 16) {
            ByteRange::Partial { start, end } => assert_eq!((start, end), (10, 15)),
            _ => panic!("open range"),
        }
        match parse_byte_range("bytes=-4", 16) {
            ByteRange::Partial { start, end } => assert_eq!((start, end), (12, 15)),
            _ => panic!("suffix range"),
        }
        assert!(matches!(parse_byte_range("bytes=20-30", 16), ByteRange::Unsatisfiable));
    }

    #[test]
    fn player_serves_only_the_requested_range() {
        let dir = std::env::temp_dir().join(format!("hgplay-dl-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("clip.mp4"), b"0123456789abcdef").unwrap();
        let origin = ensure_player(&dir).unwrap();
        let port: u16 = origin.rsplit(':').next().unwrap().parse().unwrap();
        let mut last = String::new();
        for _ in 0..20 {
            match std::net::TcpStream::connect(("127.0.0.1", port)) {
                Ok(mut sock) => {
                    sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    sock.write_all(b"GET /d/clip.mp4 HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=4-7\r\nConnection: close\r\n\r\n").unwrap();
                    let mut body = Vec::new();
                    let _ = sock.read_to_end(&mut body);
                    last = String::from_utf8_lossy(&body).into_owned();
                    if last.contains("206") && last.contains("4567") {
                        break;
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        assert!(last.contains("206 Partial Content"), "{last}");
        assert!(last.contains("Content-Range: bytes 4-7/16"), "{last}");
        assert!(last.ends_with("4567"), "{last}");
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        sock.write_all(b"GET /d/..%2Fclip.mp4 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").unwrap();
        let mut denied = Vec::new();
        let _ = sock.read_to_end(&mut denied);
        let denied = String::from_utf8_lossy(&denied);
        assert!(denied.contains("404"), "{denied}");
        let _ = fs::remove_dir_all(&dir);
    }
}
