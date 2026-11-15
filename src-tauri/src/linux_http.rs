//! Linux/GStreamer media transport. Preserve byte ranges and enforce the same
//! browser-origin boundary as the custom protocol, including in compatibility mode.
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};

pub const PORT: u16 = 17650;
pub const ORIGIN: &str = "http://127.0.0.1:17650";
const MAX_HEADERS: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 32;
static CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
struct Connection;
impl Drop for Connection {
    fn drop(&mut self) { CONNECTIONS.fetch_sub(1, Ordering::SeqCst); }
}

pub fn start() {
    std::thread::spawn(|| {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => listener,
            Err(err) => { eprintln!("[hg] media port {PORT}: {err}"); return; }
        };
        for stream in listener.incoming().flatten() {
            if CONNECTIONS.fetch_update(Ordering::SeqCst, Ordering::SeqCst,
                |n| (n < MAX_CONNECTIONS).then_some(n + 1)).is_err() { continue; }
            std::thread::spawn(move || {
                let _connection = Connection;
                if let Err(err) = serve(stream) { eprintln!("[hg] media request: {err}"); }
            });
        }
    });
}

fn parse_request(bytes: &[u8]) -> Result<tauri::http::Request<()>, u16> {
    let text = std::str::from_utf8(bytes).map_err(|_| 400u16)?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().ok_or(400u16)?.split_whitespace();
    let method = first.next().ok_or(400u16)?;
    let target = first.next().ok_or(400u16)?;
    if !target.starts_with('/') || target.starts_with("//") || first.next() != Some("HTTP/1.1") || first.next().is_some() { return Err(400); }
    if method != "GET" && method != "HEAD" { return Err(405); }
    let mut request = tauri::http::Request::builder().method(method).uri(target);
    let headers = request.headers_mut().ok_or(400u16)?;
    for line in lines {
        if line.is_empty() { break; }
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        let name = tauri::http::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| 400u16)?;
        let value = tauri::http::HeaderValue::from_str(value.trim()).map_err(|_| 400u16)?;
        if headers.contains_key(&name) { return Err(400); }
        headers.insert(name, value);
    }
    if headers.get("host").and_then(|h| h.to_str().ok()) != Some("127.0.0.1:17650") { return Err(403); }
    if let Some(origin) = headers.get("origin") {
        let origin = origin.to_str().map_err(|_| 403u16)?;
        if !super::allowed_frontend_origin(origin) { return Err(403); }
    }
    // Native GStreamer has no Fetch Metadata. Reject requests embedded by other sites.
    if !headers.contains_key("origin") && headers.get("sec-fetch-site").is_some_and(|h| h == "cross-site") { return Err(403); }
    request.body(()).map_err(|_| 400)
}

fn serve(mut stream: TcpStream) -> std::io::Result<()> {
    let timeout = Some(std::time::Duration::from_secs(30));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut head = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() { return Ok(()); }
        let take = available.len().min(MAX_HEADERS + 1 - head.len());
        let end = available[..take].windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4);
        let count = end.unwrap_or(take);
        head.extend_from_slice(&available[..count]);
        reader.consume(count);
        if head.len() > MAX_HEADERS { return write_plain(&mut stream, 431); }
        // Also handles a delimiter split between read buffers.
        if head.windows(4).any(|w| w == b"\r\n\r\n") { break; }
    }
    let request = match parse_request(&head) { Ok(r) => r, Err(status) => return write_plain(&mut stream, status) };
    let range = request.headers().get("range").and_then(|h| h.to_str().ok());
    let response = tauri::async_runtime::block_on(crate::media::handle(
        request.uri().path(), request.uri().query().unwrap_or(""), ORIGIN, range));
    let (parts, body) = response.into_parts();
    write_response(&mut stream, request.headers().get("origin").and_then(|h| h.to_str().ok()), request.method().as_str(), parts, &body)
}

fn write_response(
    stream: &mut impl Write,
    origin: Option<&str>,
    method: &str,
    parts: tauri::http::response::Parts,
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = String::with_capacity(320);
    head.push_str(&format!(
        "HTTP/1.1 {} {}\r\n",
        parts.status.as_u16(),
        parts.status.canonical_reason().unwrap_or("OK")
    ));
    head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    for (name, value) in parts.headers.iter() {
        // This server sends a complete body and closes the connection. Do not
        // duplicate media::handle's length/CORS headers or forward framing for
        // an upstream connection (WebKit rejects ambiguous HTTP framing).
        if matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "access-control-allow-origin"
        ) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            head.push_str(&format!("{}: {}\r\n", name.as_str(), value));
        }
    }
    if let Some(origin) = origin { head.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n")); }
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if method != "HEAD" {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn write_plain(stream: &mut TcpStream, status: u16) -> std::io::Result<()> {
    let reason = tauri::http::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("Error");
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::Response;
    #[test]
    fn native_ranges_and_app_origins_are_preserved() {
        let request = parse_request(b"GET /seg?u=x&direct=1 HTTP/1.1\r\nHost: 127.0.0.1:17650\r\nRange: bytes=100-199\r\n\r\n").unwrap();
        assert_eq!(request.headers()["range"], "bytes=100-199");
        assert!(parse_request(b"HEAD /hls?u=x HTTP/1.1\r\nHost: 127.0.0.1:17650\r\nOrigin: tauri://localhost\r\n\r\n").is_ok());
        assert!(parse_request(b"GET /seg?u=x HTTP/1.1\r\nHost: 127.0.0.1:17650\r\nOrigin: tauri://localhost\r\nSec-Fetch-Site: cross-site\r\n\r\n").is_ok());
    }
    #[test]
    fn foreign_pages_and_rebinding_hosts_are_denied() {
        for headers in ["Host: evil.example", "Host: 127.0.0.1:17650\r\nOrigin: https://evil.example", "Host: 127.0.0.1:17650\r\nOrigin: null", "Host: 127.0.0.1:17650\r\nSec-Fetch-Site: cross-site"] {
            assert_eq!(parse_request(format!("GET /seg?u=x HTTP/1.1\r\n{headers}\r\n\r\n").as_bytes()).unwrap_err(), 403);
        }
    }

    #[test]
    #[ignore = "local HTTP integration test; run individually with loopback access"]
    fn range_response_survives_the_linux_socket_transport() {
        use std::io::Read;
        let _guard = crate::media_cache::TEST_LOCK.lock().unwrap();
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("hghubx-linux-range-{unique}"));
        std::fs::create_dir_all(&dir).unwrap();
        crate::network_policy::bind_security(&dir);
        crate::network_policy::set_strict_security(false).unwrap();
        crate::net::refresh_client();
        crate::media_cache::bind(&dir);
        crate::media_cache::set_limit(0).unwrap();
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_url = format!("http://{}/clip.mp4", upstream.local_addr().unwrap());
        let upstream_thread = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut socket, _) = upstream.accept().unwrap();
                socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request = String::new();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" { break; }
                    request.push_str(&line);
                }
                assert!(request.to_ascii_lowercase().contains("range: bytes=2-4"));
                socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes 2-4/8\r\nContent-Length: 3\r\nConnection: close\r\n\r\ncde").unwrap();
            }
        });
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = proxy.local_addr().unwrap();
        let proxy_thread = std::thread::spawn(move || {
            for _ in 0..2 { serve(proxy.accept().unwrap().0).unwrap(); }
        });
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("u", &upstream_url).finish();
        for method in ["GET", "HEAD"] {
            let mut client = TcpStream::connect(address).unwrap();
            client.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
            write!(client, "{method} /seg?{query} HTTP/1.1\r\nHost: 127.0.0.1:17650\r\nOrigin: tauri://localhost\r\nRange: bytes=2-4\r\n\r\n").unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            let (headers, body) = response.split_once("\r\n\r\n").unwrap();
            assert!(headers.starts_with("HTTP/1.1 206"), "{response}");
            assert!(headers.to_ascii_lowercase().contains("content-range: bytes 2-4/8"));
            assert_eq!(headers.to_ascii_lowercase().matches("content-length:").count(), 1);
            assert!(headers.contains("Content-Length: 3"));
            assert!(headers.contains("Access-Control-Allow-Origin: tauri://localhost"));
            assert_eq!(body, if method == "GET" { "cde" } else { "" });
        }
        proxy_thread.join().unwrap();
        upstream_thread.join().unwrap();
        crate::network_policy::set_strict_security(true).unwrap();
        crate::media_cache::clear().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn get_has_one_authoritative_length_and_cors_header() {
        let (parts, body) = Response::builder()
            .header("Content-Length", "999")
            .header("Transfer-Encoding", "chunked")
            .header("Connection", "keep-alive")
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Type", "application/vnd.apple.mpegurl")
            .body(b"#EXTM3U\n".to_vec())
            .unwrap()
            .into_parts();
        let mut wire = Vec::new();
        write_response(&mut wire, Some("tauri://localhost"), "GET", parts, &body).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        let (head, data) = wire.split_once("\r\n\r\n").unwrap();
        let headers = head.to_ascii_lowercase();
        assert_eq!(headers.matches("content-length:").count(), 1);
        assert!(headers.contains("content-length: 8\r\n"));
        assert_eq!(headers.matches("access-control-allow-origin:").count(), 1);
        assert_eq!(headers.matches("connection:").count(), 1);
        assert!(headers.ends_with("connection: close"));
        assert!(!headers.contains("transfer-encoding:"));
        assert!(headers.contains("content-type: application/vnd.apple.mpegurl"));
        assert_eq!(data, "#EXTM3U\n");
    }

    #[test]
    fn head_keeps_representation_length_without_sending_body() {
        let (parts, body) = Response::builder()
            .status(206)
            .header("Content-Range", "bytes 0-3/20")
            .body(b"data".to_vec())
            .unwrap()
            .into_parts();
        let mut wire = Vec::new();
        write_response(&mut wire, None, "HEAD", parts, &body).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        assert!(wire.starts_with("HTTP/1.1 206 Partial Content\r\n"));
        assert!(wire.contains("Content-Length: 4\r\n"));
        assert!(wire.contains("content-range: bytes 0-3/20\r\n"));
        assert!(wire.ends_with("\r\n\r\n"));
    }
}
