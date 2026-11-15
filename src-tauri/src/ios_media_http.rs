//! iOS 15、16、17.0 的 WKWebView 没有 MediaSource。系统播放器也不会走 `hg://` 自定义协议，
//! 直接把该地址交给 `<video>` 会报「格式不受支持」。这里在 127.0.0.1 上复用同一套
//! 播放列表改写，让 AVPlayer 用普通 HTTP 拉 m3u8、分片和密钥。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
static ORIGIN: Mutex<Option<String>> = Mutex::new(None);
static INFLIGHT: AtomicUsize = AtomicUsize::new(0);
const MAX_CONN: usize = 48;
const MAX_HEADERS: usize = 64 * 1024;

pub fn ensure_started() -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        start()
    }
    #[cfg(not(target_os = "ios"))]
    {
        Ok(String::new())
    }
}

#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn start() -> Result<String, String> {
    let mut slot = ORIGIN.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(origin) = slot.clone() {
        return Ok(origin);
    }
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("本机播放端口绑定失败: {err}"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|err| format!("本机播放端口设置失败: {err}"))?;
    let port = std_listener
        .local_addr()
        .map_err(|err| format!("本机播放端口读取失败: {err}"))?
        .port();
    let origin = format!("http://127.0.0.1:{port}");
    *slot = Some(origin.clone());
    drop(slot);

    let origin_for_task = origin.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(_) => {
                let mut slot = ORIGIN.lock().unwrap_or_else(|err| err.into_inner());
                if slot.as_deref() == Some(origin_for_task.as_str()) {
                    *slot = None;
                }
                return;
            }
        };
        accept_loop(listener, origin_for_task).await;
    });
    Ok(origin)
}

#[tauri::command]
pub fn media_http_origin() -> Result<String, String> {
    ensure_started()
}

async fn accept_loop(listener: TcpListener, origin: String) {
    loop {
        match listener.accept().await {
            Ok((sock, _)) => {
                if INFLIGHT.load(Ordering::Relaxed) >= MAX_CONN {
                    drop(sock);
                    continue;
                }
                INFLIGHT.fetch_add(1, Ordering::Relaxed);
                let origin = origin.clone();
                tokio::spawn(async move {
                    let _ = serve(sock, &origin).await;
                    INFLIGHT.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(_) => break,
        }
    }
}

struct Request<'a> {
    method: &'a str,
    path: &'a str,
    query: &'a str,
    range: Option<&'a str>,
}

async fn serve(mut sock: TcpStream, origin: &str) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    let header_end = loop {
        let read = sock.read(&mut tmp).await?;
        if read == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..read]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEADERS {
            return write_simple(&mut sock, 400, b"headers too large").await;
        }
    };
    let head = match std::str::from_utf8(&buf[..header_end]) {
        Ok(text) => text,
        Err(_) => return write_simple(&mut sock, 400, b"bad request").await,
    };
    let Some(request) = parse_request(head) else {
        return write_simple(&mut sock, 400, b"bad request").await;
    };
    if request.query.len() > 16 * 1024 {
        return write_simple(&mut sock, 400, b"query too large").await;
    }
    if request.method == "OPTIONS" {
        return write_preflight(&mut sock).await;
    }
    if request.method != "GET" && request.method != "HEAD" {
        return write_simple(&mut sock, 405, b"method not allowed").await;
    }
    if !matches!(request.path, "/hls" | "/seg" | "/img") {
        return write_simple(&mut sock, 404, b"not found").await;
    }
    let response = crate::media::handle(request.path, request.query, origin, None).await;
    write_media(&mut sock, request.method, request.range, response).await
}

fn parse_request(head: &str) -> Option<Request<'_>> {
    let mut lines = head.split("\r\n");
    let request = lines.next()?;
    let mut parts = request.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    let _version = parts.next()?;
    if !target.starts_with('/') || target.contains("..") {
        return None;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let path = path.split('#').next().unwrap_or(path);
    if path.is_empty() {
        return None;
    }
    let mut range = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("range") {
            range = Some(value.trim());
        }
    }
    Some(Request {
        method,
        path,
        query,
        range,
    })
}

enum Clip<'a> {
    Full(&'a [u8]),
    Partial {
        start: usize,
        end: usize,
        total: usize,
        bytes: &'a [u8],
    },
    Unsatisfiable(usize),
}

fn clip<'a>(body: &'a [u8], range: Option<&str>) -> Clip<'a> {
    let Some(header) = range else {
        return Clip::Full(body);
    };
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return Clip::Full(body);
    };
    if spec.is_empty() || spec.contains(',') {
        return Clip::Full(body);
    }
    let Some((start_s, end_s)) = spec.split_once('-') else {
        return Clip::Full(body);
    };
    let len = body.len();
    if len == 0 {
        return Clip::Full(body);
    }
    if start_s.is_empty() {
        let Ok(suffix) = end_s.parse::<usize>() else {
            return Clip::Full(body);
        };
        if suffix == 0 {
            return Clip::Full(body);
        }
        let take = suffix.min(len);
        let start = len - take;
        return Clip::Partial {
            start,
            end: len - 1,
            total: len,
            bytes: &body[start..],
        };
    }
    let Ok(start) = start_s.parse::<usize>() else {
        return Clip::Full(body);
    };
    if start >= len {
        return Clip::Unsatisfiable(len);
    }
    let end = if end_s.is_empty() {
        len - 1
    } else {
        let Ok(end) = end_s.parse::<usize>() else {
            return Clip::Full(body);
        };
        end.min(len - 1)
    };
    if end < start {
        return Clip::Unsatisfiable(len);
    }
    Clip::Partial {
        start,
        end,
        total: len,
        bytes: &body[start..=end],
    }
}

async fn write_media(
    sock: &mut TcpStream,
    method: &str,
    range: Option<&str>,
    response: tauri::http::Response<Vec<u8>>,
) -> std::io::Result<()> {
    let status = response.status().as_u16();
    let content_type = safe_header(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream"),
        "application/octet-stream",
    );
    let cache = safe_header(
        response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("no-store"),
        "no-store",
    );
    // 播放列表被 Range 截断后，系统 HLS 会当成坏文件。分片才按 Range 返回。
    // 见 https://github.com/tauri-apps/tauri/issues/3143
    let playlist = content_type.to_ascii_lowercase().contains("mpegurl");
    let range = if playlist { None } else { range };
    let ranges = if playlist {
        "none".to_string()
    } else {
        "bytes".to_string()
    };
    if status != 200 {
        let full = response.body();
        let body = if method == "HEAD" { &[][..] } else { full };
        return write_bytes(
            sock,
            status,
            &[
                ("Content-Type", content_type),
                ("Content-Length", full.len().to_string()),
                ("Cache-Control", cache),
                ("Accept-Ranges", ranges),
                ("Access-Control-Allow-Origin", "*".to_string()),
                ("Connection", "close".to_string()),
            ],
            body,
        )
        .await;
    }

    match clip(response.body(), range) {
        Clip::Full(bytes) => {
            let body = if method == "HEAD" { &[][..] } else { bytes };
            write_bytes(
                sock,
                200,
                &[
                    ("Content-Type", content_type),
                    ("Content-Length", bytes.len().to_string()),
                    ("Cache-Control", cache),
                    ("Accept-Ranges", ranges),
                    ("Access-Control-Allow-Origin", "*".to_string()),
                    ("Connection", "close".to_string()),
                ],
                body,
            )
            .await
        }
        Clip::Partial {
            start,
            end,
            total,
            bytes,
        } => {
            let body = if method == "HEAD" { &[][..] } else { bytes };
            write_bytes(
                sock,
                206,
                &[
                    ("Content-Type", content_type),
                    ("Content-Length", bytes.len().to_string()),
                    ("Content-Range", format!("bytes {start}-{end}/{total}")),
                    ("Cache-Control", cache),
                    ("Accept-Ranges", "bytes".to_string()),
                    ("Access-Control-Allow-Origin", "*".to_string()),
                    ("Connection", "close".to_string()),
                ],
                body,
            )
            .await
        }
        Clip::Unsatisfiable(total) => {
            write_bytes(
                sock,
                416,
                &[
                    ("Content-Type", "text/plain".to_string()),
                    ("Content-Length", "0".to_string()),
                    ("Content-Range", format!("bytes */{total}")),
                    ("Accept-Ranges", "bytes".to_string()),
                    ("Access-Control-Allow-Origin", "*".to_string()),
                    ("Connection", "close".to_string()),
                ],
                b"",
            )
            .await
        }
    }
}

fn safe_header(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed
            .bytes()
            .any(|byte| byte == b'\r' || byte == b'\n' || byte == 0)
    {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

async fn write_simple(sock: &mut TcpStream, status: u16, body: &[u8]) -> std::io::Result<()> {
    write_bytes(
        sock,
        status,
        &[
            ("Content-Type", "text/plain".to_string()),
            ("Content-Length", body.len().to_string()),
            ("Access-Control-Allow-Origin", "*".to_string()),
            ("Connection", "close".to_string()),
        ],
        body,
    )
    .await
}

async fn write_preflight(sock: &mut TcpStream) -> std::io::Result<()> {
    write_bytes(
        sock,
        204,
        &[
            ("Content-Length", "0".to_string()),
            ("Access-Control-Allow-Origin", "*".to_string()),
            ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS".to_string()),
            ("Access-Control-Allow-Headers", "Range".to_string()),
            ("Access-Control-Max-Age", "86400".to_string()),
            ("Connection", "close".to_string()),
        ],
        b"",
    )
    .await
}

async fn write_bytes(
    sock: &mut TcpStream,
    status: u16,
    headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (name, value) in headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    sock.write_all(head.as_bytes()).await?;
    if !body.is_empty() {
        sock.write_all(body).await?;
    }
    sock.shutdown().await?;
    Ok(())
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        502 => "Bad Gateway",
        _ => "Error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_ranges_cover_probe_suffix_and_overflow() {
        let body = b"abcdefghijklmnopqrstuvwxyz";
        match clip(body, Some("bytes=0-3")) {
            Clip::Partial { start, end, bytes, .. } => {
                assert_eq!((start, end, bytes), (0, 3, &b"abcd"[..]));
            }
            _ => panic!("expected partial"),
        }
        match clip(body, Some("bytes=-4")) {
            Clip::Partial { start, bytes, .. } => assert_eq!((start, bytes), (22, &b"wxyz"[..])),
            _ => panic!("expected suffix"),
        }
        match clip(body, Some("bytes=100-120")) {
            Clip::Unsatisfiable(total) => assert_eq!(total, 26),
            _ => panic!("expected unsatisfiable"),
        }
        match clip(body, None) {
            Clip::Full(bytes) => assert_eq!(bytes.len(), 26),
            _ => panic!("expected full"),
        }
    }

    #[tokio::test]
    async fn unknown_route_and_empty_playlist_do_not_touch_upstream() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let origin = format!("http://127.0.0.1:{port}");
        tokio::spawn(async move { accept_loop(listener, origin).await });

        let missing = request(port, "GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await;
        assert!(missing.starts_with("HTTP/1.1 404"), "{missing}");

        let empty = request(port, "GET /hls?u= HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await;
        assert!(empty.starts_with("HTTP/1.1 400"), "{empty}");
        assert!(empty.contains("missing u"));
    }

    async fn request(port: u16, raw: &str) -> String {
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        sock.write_all(raw.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(2), sock.read_to_end(&mut out))
            .await
            .expect("timeout")
            .unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }
}
