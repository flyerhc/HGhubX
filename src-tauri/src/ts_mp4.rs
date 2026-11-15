//! 把拼好的 MPEG-TS（H.264 + AAC）重封装成 MP4。
//!
//! 只改容器：Annex-B 换成长度前缀，ADTS 去掉头，时间戳写进 stts/ctts。
//! 不解码、不重新编码。HEVC 或解析失败时返回错误，调用方继续保存 `.ts`。

const TS_PACKET: usize = 188;
const TIMESCALES: u32 = 90_000;

pub fn remux_ts(data: &[u8]) -> Result<Vec<u8>, &'static str> {
    let data = aligned_ts(data)?;
    let (video_pid, audio_pid) = discover_pids(data)?;
    let (video_pes, audio_pes) = collect_pes(data, video_pid, audio_pid);
    let video = build_video(&video_pes)?;
    let audio = take_audio(&audio_pes);
    build_mp4(&video, audio.as_ref())
}

fn aligned_ts(data: &[u8]) -> Result<&[u8], &'static str> {
    if data.len() >= TS_PACKET && data[0] == 0x47 && data.len() % TS_PACKET == 0 && sync_ok(data) {
        return Ok(data);
    }
    let limit = data.len().saturating_sub(TS_PACKET * 2).min(2048);
    for i in 0..limit {
        if data[i] == 0x47
            && data.get(i + TS_PACKET) == Some(&0x47)
            && data.get(i + TS_PACKET * 2) == Some(&0x47)
        {
            let packets = (data.len() - i) / TS_PACKET;
            let slice = &data[i..i + packets * TS_PACKET];
            if sync_ok(slice) {
                return Ok(slice);
            }
        }
    }
    Err("不是 MPEG-TS")
}

fn sync_ok(data: &[u8]) -> bool {
    !data.is_empty() && data.len() % TS_PACKET == 0 && data.chunks(TS_PACKET).all(|pkt| pkt[0] == 0x47)
}

fn discover_pids(data: &[u8]) -> Result<(u16, Option<u16>), &'static str> {
    let mut pat = PsiBuild::default();
    let mut pmt_pid = None;
    let mut pmt = PsiBuild::default();
    let mut video_pid = None;
    let mut audio_pid = None;
    let mut saw_hevc = false;
    for pkt in data.chunks(TS_PACKET) {
        if pkt[1] & 0x80 != 0 {
            continue;
        }
        let pid = pid_of(pkt);
        let start = pkt[1] & 0x40 != 0;
        let Some(payload) = payload_of(pkt) else { continue };
        if pid == 0 {
            for section in pat.feed(payload, start) {
                if pmt_pid.is_none() {
                    pmt_pid = first_pmt_pid(&section);
                }
            }
            continue;
        }
        if Some(pid) != pmt_pid || video_pid.is_some() {
            continue;
        }
        for section in pmt.feed(payload, start) {
            if video_pid.is_some() {
                break;
            }
            for (stream_type, elementary) in pmt_streams(&section) {
                match stream_type {
                    0x1B if video_pid.is_none() => video_pid = Some(elementary),
                    0x0F if audio_pid.is_none() => audio_pid = Some(elementary),
                    0x24 => saw_hevc = true,
                    _ => {}
                }
            }
        }
    }
    if let Some(video_pid) = video_pid {
        return Ok((video_pid, audio_pid));
    }
    if saw_hevc {
        Err("只有 HEVC，不能转成 mp4")
    } else {
        Err("没有 H.264 视频")
    }
}

struct Elementary {
    pts: Option<u64>,
    dts: Option<u64>,
    data: Vec<u8>,
}

fn collect_pes(data: &[u8], video_pid: u16, audio_pid: Option<u16>) -> (Vec<Elementary>, Vec<Elementary>) {
    let mut video_acc = PesAcc::default();
    let mut audio_acc = PesAcc::default();
    let mut video = Vec::new();
    let mut audio = Vec::new();
    for pkt in data.chunks(TS_PACKET) {
        if pkt[1] & 0x80 != 0 {
            continue;
        }
        let pid = pid_of(pkt);
        let start = pkt[1] & 0x40 != 0;
        let Some(payload) = payload_of(pkt) else { continue };
        if pid == video_pid {
            if let Some(done) = video_acc.feed(payload, start) {
                push_pes(&mut video, done);
            }
        } else if Some(pid) == audio_pid {
            if let Some(done) = audio_acc.feed(payload, start) {
                push_pes(&mut audio, done);
            }
        }
    }
    if let Some(done) = video_acc.finish() {
        push_pes(&mut video, done);
    }
    if let Some(done) = audio_acc.finish() {
        push_pes(&mut audio, done);
    }
    (video, audio)
}

fn push_pes(out: &mut Vec<Elementary>, raw: Vec<u8>) {
    let Some((pts, dts, payload)) = parse_pes(&raw) else { return };
    if payload.is_empty() {
        return;
    }
    out.push(Elementary { pts, dts, data: payload.to_vec() });
}

#[derive(Default)]
struct PesAcc {
    buf: Vec<u8>,
    drop: bool,
}

impl PesAcc {
    fn feed(&mut self, payload: &[u8], start: bool) -> Option<Vec<u8>> {
        const CAP: usize = 16 * 1024 * 1024;
        if start {
            let prev = if self.drop || self.buf.is_empty() {
                None
            } else {
                Some(std::mem::take(&mut self.buf))
            };
            self.drop = false;
            self.buf.clear();
            if payload.len() > CAP {
                self.drop = true;
            } else {
                self.buf.extend_from_slice(payload);
            }
            prev
        } else if self.drop || self.buf.is_empty() {
            None
        } else if self.buf.len() + payload.len() > CAP {
            self.buf.clear();
            self.drop = true;
            None
        } else {
            self.buf.extend_from_slice(payload);
            None
        }
    }

    fn finish(&mut self) -> Option<Vec<u8>> {
        if self.drop || self.buf.is_empty() {
            self.buf.clear();
            self.drop = false;
            None
        } else {
            Some(std::mem::take(&mut self.buf))
        }
    }
}

fn pid_of(pkt: &[u8]) -> u16 {
    (((pkt[1] & 0x1F) as u16) << 8) | pkt[2] as u16
}

fn payload_of(pkt: &[u8]) -> Option<&[u8]> {
    let afc = (pkt[3] >> 4) & 0x03;
    let offset = match afc {
        1 => 4,
        3 => {
            let af_len = pkt[4] as usize;
            5 + af_len
        }
        _ => return None,
    };
    if offset >= TS_PACKET {
        None
    } else {
        Some(&pkt[offset..])
    }
}

#[derive(Default)]
struct PsiBuild {
    buf: Vec<u8>,
}

impl PsiBuild {
    fn feed(&mut self, payload: &[u8], start: bool) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        if payload.is_empty() {
            return out;
        }
        let mut rest = payload;
        if start {
            let pointer = rest[0] as usize;
            if rest.len() < 1 + pointer {
                return out;
            }
            if pointer > 0 && !self.buf.is_empty() {
                self.buf.extend_from_slice(&rest[1..1 + pointer]);
                if let Some(section) = take_section(&mut self.buf) {
                    out.push(section);
                }
            }
            self.buf.clear();
            rest = &rest[1 + pointer..];
        } else if self.buf.is_empty() {
            return out;
        }
        self.buf.extend_from_slice(rest);
        while !self.buf.is_empty() && self.buf[0] != 0xFF {
            match take_section(&mut self.buf) {
                Some(section) => out.push(section),
                None => break,
            }
        }
        if self.buf.first() == Some(&0xFF) || self.buf.len() > 1024 {
            self.buf.clear();
        }
        out
    }
}

fn take_section(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    if buf.len() < 3 {
        return None;
    }
    let len = (((buf[1] & 0x0F) as usize) << 8) | buf[2] as usize;
    let total = 3 + len;
    if total < 3 || buf.len() < total {
        return None;
    }
    let section = buf[..total].to_vec();
    buf.drain(..total);
    Some(section)
}

fn first_pmt_pid(section: &[u8]) -> Option<u16> {
    if section.first() != Some(&0x00) || section.len() < 12 {
        return None;
    }
    let end = section_end(section);
    let mut i = 8;
    while i + 4 <= end.saturating_sub(4) {
        let program = u16::from_be_bytes([section[i], section[i + 1]]);
        let pid = u16::from_be_bytes([section[i + 2], section[i + 3]]) & 0x1FFF;
        if program != 0 {
            return Some(pid);
        }
        i += 4;
    }
    None
}

fn pmt_streams(section: &[u8]) -> Vec<(u8, u16)> {
    if section.first() != Some(&0x02) || section.len() < 12 {
        return Vec::new();
    }
    let end = section_end(section);
    let info_len = (u16::from_be_bytes([section[10], section[11]]) & 0x0FFF) as usize;
    let mut i = 12 + info_len;
    let mut streams = Vec::new();
    while i + 5 <= end.saturating_sub(4) {
        let stream_type = section[i];
        let pid = u16::from_be_bytes([section[i + 1], section[i + 2]]) & 0x1FFF;
        let es_len = (u16::from_be_bytes([section[i + 3], section[i + 4]]) & 0x0FFF) as usize;
        streams.push((stream_type, pid));
        i += 5 + es_len;
    }
    streams
}

fn section_end(section: &[u8]) -> usize {
    let len = (((section[1] & 0x0F) as usize) << 8) | section[2] as usize;
    (3 + len).min(section.len())
}

fn parse_pes(data: &[u8]) -> Option<(Option<u64>, Option<u64>, &[u8])> {
    if data.len() < 6 || data[0] != 0 || data[1] != 0 || data[2] != 1 {
        return None;
    }
    let stream_id = data[3];
    let packet_len = u16::from_be_bytes([data[4], data[5]]) as usize;
    let end = if packet_len == 0 { data.len() } else { (6 + packet_len).min(data.len()) };
    let data = &data[..end];
    if matches!(stream_id, 0xBC | 0xBE | 0xBF | 0xF0 | 0xF1 | 0xF2 | 0xF8 | 0xFF) {
        return Some((None, None, &data[6..]));
    }
    if data.len() < 9 {
        return None;
    }
    if data[6] & 0xC0 != 0x80 || (data[6] >> 4) & 0x03 != 0 {
        return None;
    }
    let header_len = data[8] as usize;
    let payload_at = 9 + header_len;
    if data.len() < payload_at {
        return None;
    }
    let flags = data[7];
    let mut pts = None;
    let mut dts = None;
    if flags & 0x80 != 0 {
        if header_len < 5 || data.len() < 14 {
            return None;
        }
        pts = Some(read_ts(&data[9..14]));
        if flags & 0x40 != 0 {
            if header_len < 10 || data.len() < 19 {
                return None;
            }
            dts = Some(read_ts(&data[14..19]));
        } else {
            dts = pts;
        }
    }
    Some((pts, dts, &data[payload_at..]))
}

fn read_ts(bytes: &[u8]) -> u64 {
    let b0 = bytes[0] as u64;
    let b1 = bytes[1] as u64;
    let b2 = bytes[2] as u64;
    let b3 = bytes[3] as u64;
    let b4 = bytes[4] as u64;
    ((b0 & 0x0E) << 29) | (b1 << 22) | ((b2 & 0xFE) << 14) | (b3 << 7) | ((b4 & 0xFE) >> 1)
}

struct VSample {
    data: Vec<u8>,
    pts: Option<u64>,
    dts: Option<u64>,
    key: bool,
}

struct VideoBuilt {
    samples: Vec<VSample>,
    sps: Vec<Vec<u8>>,
    pps: Vec<Vec<u8>>,
    width: u32,
    height: u32,
}

struct AudioBuilt {
    frames: Vec<Vec<u8>>,
    aot: u8,
    freq_index: u8,
    channels: u8,
    rate: u32,
    pts0: Option<u64>,
}

fn build_video(chunks: &[Elementary]) -> Result<VideoBuilt, &'static str> {
    let mut es = Vec::new();
    let mut stamps = Vec::new();
    for chunk in chunks {
        stamps.push((es.len(), chunk.pts, chunk.dts));
        es.extend_from_slice(&chunk.data);
    }
    let units = nal_units(&es);
    let mut samples = Vec::new();
    let mut sps = Vec::new();
    let mut pps = Vec::new();
    let mut au = Vec::new();
    let mut has_vcl = false;
    let mut key = false;
    let mut au_pts = None;
    let mut au_dts = None;
    let mut prefix: Vec<Vec<u8>> = Vec::new();
    let mut used_stamp: Option<usize> = None;

    let mut flush = |au: &mut Vec<u8>, has_vcl: &mut bool, key: &mut bool, au_pts: &mut Option<u64>, au_dts: &mut Option<u64>| {
        if *has_vcl && !au.is_empty() {
            samples.push(VSample {
                data: std::mem::take(au),
                pts: au_pts.take(),
                dts: au_dts.take(),
                key: *key,
            });
        } else {
            au.clear();
            *au_pts = None;
            *au_dts = None;
        }
        *has_vcl = false;
        *key = false;
    };

    for (offset, nal) in units {
        if nal.is_empty() {
            continue;
        }
        let kind = nal[0] & 0x1F;
        match kind {
            7 => {
                if has_vcl {
                    flush(&mut au, &mut has_vcl, &mut key, &mut au_pts, &mut au_dts);
                }
                push_unique(&mut sps, nal);
            }
            8 => {
                if has_vcl {
                    flush(&mut au, &mut has_vcl, &mut key, &mut au_pts, &mut au_dts);
                }
                push_unique(&mut pps, nal);
            }
            9 | 10 | 11 | 12 => {
                flush(&mut au, &mut has_vcl, &mut key, &mut au_pts, &mut au_dts);
                prefix.clear();
            }
            6 => {
                if has_vcl {
                    flush(&mut au, &mut has_vcl, &mut key, &mut au_pts, &mut au_dts);
                }
                prefix.push(nal.to_vec());
            }
            1..=5 => {
                if slice_starts_picture(nal) && has_vcl {
                    flush(&mut au, &mut has_vcl, &mut key, &mut au_pts, &mut au_dts);
                }
                if !has_vcl {
                    for sei in prefix.drain(..) {
                        push_nal(&mut au, &sei);
                    }
                    if let Some(idx) = stamps.iter().rposition(|(at, _, _)| *at <= offset) {
                        if used_stamp != Some(idx) {
                            used_stamp = Some(idx);
                            au_pts = stamps[idx].1;
                            au_dts = stamps[idx].2.or(stamps[idx].1);
                        }
                    }
                }
                if kind == 5 {
                    key = true;
                }
                push_nal(&mut au, nal);
                has_vcl = true;
            }
            _ => {
                if has_vcl {
                    push_nal(&mut au, nal);
                } else {
                    prefix.push(nal.to_vec());
                }
            }
        }
    }
    flush(&mut au, &mut has_vcl, &mut key, &mut au_pts, &mut au_dts);
    if samples.is_empty() {
        return Err("没有可用的视频帧");
    }
    if sps.is_empty() || pps.is_empty() {
        return Err("缺少 SPS 或 PPS");
    }
    if !samples.iter().any(|sample| sample.key) {
        samples[0].key = true;
    }
    let (width, height) = sps_dimensions(&sps[0]).unwrap_or((1280, 720));
    Ok(VideoBuilt { samples, sps, pps, width, height })
}

fn push_unique(list: &mut Vec<Vec<u8>>, nal: &[u8]) {
    if list.iter().any(|have| have.as_slice() == nal) || list.len() >= 8 {
        return;
    }
    list.push(nal.to_vec());
}

fn push_nal(out: &mut Vec<u8>, nal: &[u8]) {
    out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
    out.extend_from_slice(nal);
}

fn nal_units(data: &[u8]) -> Vec<(usize, &[u8])> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 < data.len() {
        let start_len = if i + 4 <= data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1 {
            Some(4)
        } else if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            Some(3)
        } else {
            None
        };
        if let Some(len) = start_len {
            starts.push((i, i + len));
            i += len;
        } else {
            i += 1;
        }
    }
    let mut units = Vec::new();
    for (n, &(_, nal_at)) in starts.iter().enumerate() {
        let end = if n + 1 < starts.len() { starts[n + 1].0 } else { data.len() };
        if nal_at < end {
            units.push((nal_at, &data[nal_at..end]));
        }
    }
    units
}

fn slice_starts_picture(nal: &[u8]) -> bool {
    if nal.len() < 2 {
        return true;
    }
    let rbsp = strip_epb(&nal[1..]);
    let mut bits = BitReader::new(&rbsp);
    matches!(ue(&mut bits), Some(0) | None)
}

fn take_audio(chunks: &[Elementary]) -> Option<AudioBuilt> {
    if chunks.is_empty() {
        return None;
    }
    let mut es = Vec::new();
    let mut pts0 = None;
    for chunk in chunks {
        if pts0.is_none() {
            pts0 = chunk.pts;
        }
        es.extend_from_slice(&chunk.data);
    }
    let (cfg, frames) = parse_adts(&es)?;
    if frames.is_empty() {
        return None;
    }
    Some(AudioBuilt {
        frames,
        aot: cfg.0,
        freq_index: cfg.1,
        channels: cfg.2,
        rate: cfg.3,
        pts0,
    })
}

fn parse_adts(data: &[u8]) -> Option<((u8, u8, u8, u32), Vec<Vec<u8>>)> {
    const RATES: [u32; 13] = [
        96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ];
    let mut i = 0;
    let mut frames = Vec::new();
    let mut config = None;
    while i + 7 <= data.len() {
        if data[i] != 0xFF || data[i + 1] & 0xF0 != 0xF0 {
            i += 1;
            continue;
        }
        let protection_absent = data[i + 1] & 0x01;
        let profile = (data[i + 2] >> 6) & 0x03;
        let freq_index = (data[i + 2] >> 2) & 0x0F;
        let channels = ((data[i + 2] & 0x01) << 2) | ((data[i + 3] >> 6) & 0x03);
        let frame_len = (((data[i + 3] & 0x03) as usize) << 11)
            | ((data[i + 4] as usize) << 3)
            | ((data[i + 5] >> 5) as usize);
        let header = if protection_absent == 1 { 7 } else { 9 };
        if frame_len < header || frame_len > 8192 || i + frame_len > data.len() || freq_index >= 13 || channels == 0 {
            i += 1;
            continue;
        }
        let rate = RATES[freq_index as usize];
        if rate == 0 {
            i += 1;
            continue;
        }
        if config.is_none() {
            config = Some((profile + 1, freq_index, channels, rate));
        }
        let raw = &data[i + header..i + frame_len];
        if !raw.is_empty() {
            frames.push(raw.to_vec());
        }
        i += frame_len;
    }
    Some((config?, frames))
}

fn build_mp4(video: &VideoBuilt, audio: Option<&AudioBuilt>) -> Result<Vec<u8>, &'static str> {
    let (deltas, cto) = timing(&video.samples);
    let video_media: u64 = deltas.iter().map(|d| *d as u64).sum();
    let video_pts0 = video.samples.iter().find_map(|sample| sample.pts);
    let audio_pts0 = audio.and_then(|track| track.pts0);
    let (video_delay, audio_delay) = match (video_pts0, audio_pts0) {
        (Some(v), Some(a)) if v > a && v - a > 3000 => (v - a, 0),
        (Some(v), Some(a)) if a > v && a - v > 3000 => (0, a - v),
        _ => (0, 0),
    };
    let audio_movie = audio
        .map(|track| {
            let ticks = track.frames.len() as u64 * 1024;
            ticks.saturating_mul(TIMESCALES as u64) / track.rate as u64
        })
        .unwrap_or(0);
    let video_movie = video_delay + video_media;
    let audio_span = audio_delay + audio_movie;
    let movie_dur = video_movie.max(audio_span);
    let _ = fit_u32(movie_dur)?;
    let _ = fit_u32(video_media)?;

    let video_bytes: usize = video.samples.iter().map(|sample| sample.data.len()).sum();
    let audio_bytes: usize = audio.map(|track| track.frames.iter().map(|frame| frame.len()).sum()).unwrap_or(0);
    let wide = (video_bytes + audio_bytes) as u64 > 3_000_000_000;
    let ftyp = ftyp();
    let moov_len = moov(video, audio, &deltas, &cto, video_delay, audio_delay, video_media, audio_movie, movie_dur, 0, 0, wide)?.len();
    let mdat_data = ftyp.len() + moov_len + 8;
    let audio_at = mdat_data + video_bytes;
    let moov = moov(
        video,
        audio,
        &deltas,
        &cto,
        video_delay,
        audio_delay,
        video_media,
        audio_movie,
        movie_dur,
        mdat_data as u64,
        audio_at as u64,
        wide,
    )?;
    if moov.len() != moov_len {
        return Err("封装尺寸对不上");
    }
    let mut out = Vec::with_capacity(mdat_data + video_bytes + audio_bytes);
    out.extend(ftyp);
    out.extend(moov);
    let mdat_len = 8 + video_bytes + audio_bytes;
    let _ = fit_u32(mdat_len as u64)?;
    out.extend_from_slice(&(mdat_len as u32).to_be_bytes());
    out.extend_from_slice(b"mdat");
    for sample in &video.samples {
        out.extend_from_slice(&sample.data);
    }
    if let Some(track) = audio {
        for frame in &track.frames {
            out.extend_from_slice(frame);
        }
    }
    Ok(out)
}

fn timing(samples: &[VSample]) -> (Vec<u32>, Vec<u32>) {
    let frame = frame_duration(samples);
    let mut owned: Vec<(Option<u64>, Option<u64>)> = samples.iter().map(|sample| (sample.pts, sample.dts)).collect();
    let dts_ok = owned.windows(2).all(|pair| matches!((pair[0].1, pair[1].1), (Some(a), Some(b)) if b >= a));
    let all_dts = owned.iter().all(|stamp| stamp.1.is_some());
    if !(dts_ok && all_dts) {
        let origin = owned.iter().filter_map(|stamp| stamp.0).min().unwrap_or(0);
        for (i, stamp) in owned.iter_mut().enumerate() {
            let dts = origin + i as u64 * frame as u64;
            if stamp.0.is_none() {
                stamp.0 = Some(dts);
            }
            stamp.1 = Some(dts);
        }
    } else {
        for stamp in &mut owned {
            if stamp.0.is_none() {
                stamp.0 = stamp.1;
            }
        }
    }
    let mut deltas = Vec::with_capacity(owned.len());
    for pair in owned.windows(2) {
        let mut delta = pair[1].1.unwrap_or(0).saturating_sub(pair[0].1.unwrap_or(0));
        if delta == 0 || delta > TIMESCALES as u64 * 5 {
            delta = frame as u64;
        }
        deltas.push(delta as u32);
    }
    deltas.push(frame);
    let mut cto: Vec<i64> = owned
        .iter()
        .map(|stamp| stamp.0.unwrap_or(0) as i64 - stamp.1.unwrap_or(0) as i64)
        .collect();
    let min = cto.iter().copied().min().unwrap_or(0);
    if min < 0 {
        for value in &mut cto {
            *value -= min;
        }
    }
    let cto = cto.iter().map(|value| (*value).max(0) as u32).collect();
    (deltas, cto)
}

fn frame_duration(samples: &[VSample]) -> u32 {
    let mut pts: Vec<u64> = samples.iter().filter_map(|sample| sample.pts).collect();
    if pts.len() < 2 {
        return 3000;
    }
    pts.sort_unstable();
    let mut diffs: Vec<u64> = pts.windows(2).map(|pair| pair[1] - pair[0]).filter(|d| (1..TIMESCALES as u64).contains(d)).collect();
    if diffs.is_empty() {
        return 3000;
    }
    diffs.sort_unstable();
    diffs[diffs.len() / 2] as u32
}

fn fit_u32(n: u64) -> Result<u32, &'static str> {
    u32::try_from(n).map_err(|_| "视频太长，先保留为 ts")
}

fn moov(
    video: &VideoBuilt,
    audio: Option<&AudioBuilt>,
    deltas: &[u32],
    cto: &[u32],
    video_delay: u64,
    audio_delay: u64,
    video_media: u64,
    audio_movie: u64,
    movie_dur: u64,
    video_offset: u64,
    audio_offset: u64,
    wide: bool,
) -> Result<Vec<u8>, &'static str> {
    let mut body = mvhd(movie_dur, if audio.is_some() { 3 } else { 2 })?;
    body.extend(video_trak(video, deltas, cto, video_delay, video_media, video_offset, wide)?);
    if let Some(track) = audio {
        body.extend(audio_trak(track, audio_delay, audio_movie, audio_offset, wide)?);
    }
    Ok(be_box(b"moov", &body))
}

fn video_trak(
    video: &VideoBuilt,
    deltas: &[u32],
    cto: &[u32],
    delay: u64,
    media: u64,
    offset: u64,
    wide: bool,
) -> Result<Vec<u8>, &'static str> {
    let movie_dur = delay + media;
    let mut body = tkhd(1, movie_dur, 0, video.width, video.height)?;
    if let Some(edits) = elst(delay, media)? {
        body.extend(edits);
    }
    let mut stbl = stsd(&avc1(video)?);
    stbl.extend(stts(deltas));
    if cto.iter().any(|value| *value != 0) {
        stbl.extend(ctts(cto));
    }
    let keys: Vec<u32> = video
        .samples
        .iter()
        .enumerate()
        .filter(|(_, sample)| sample.key)
        .map(|(i, _)| i as u32 + 1)
        .collect();
    stbl.extend(stss(&keys));
    stbl.extend(stsc(video.samples.len() as u32));
    let sizes: Vec<u32> = video.samples.iter().map(|sample| sample.data.len() as u32).collect();
    stbl.extend(stsz(&sizes));
    stbl.extend(chunk_offset(offset, wide));
    let minf = {
        let mut m = vmhd();
        m.extend(dinf());
        m.extend(be_box(b"stbl", &stbl));
        be_box(b"minf", &m)
    };
    let mdia = {
        let mut m = mdhd(TIMESCALES, media)?;
        m.extend(hdlr(b"vide", "VideoHandler"));
        m.extend(minf);
        be_box(b"mdia", &m)
    };
    body.extend(mdia);
    Ok(be_box(b"trak", &body))
}

fn audio_trak(track: &AudioBuilt, delay: u64, movie_dur: u64, offset: u64, wide: bool) -> Result<Vec<u8>, &'static str> {
    let media = track.frames.len() as u64 * 1024;
    let _ = fit_u32(media)?;
    let mut body = tkhd(2, delay + movie_dur, 0x0100, 0, 0)?;
    if let Some(edits) = elst(delay, movie_dur)? {
        body.extend(edits);
    }
    let mut stbl = stsd(&mp4a(track)?);
    let deltas = vec![1024u32; track.frames.len()];
    stbl.extend(stts(&deltas));
    stbl.extend(stsc(track.frames.len() as u32));
    let sizes: Vec<u32> = track.frames.iter().map(|frame| frame.len() as u32).collect();
    stbl.extend(stsz(&sizes));
    stbl.extend(chunk_offset(offset, wide));
    let minf = {
        let mut m = smhd();
        m.extend(dinf());
        m.extend(be_box(b"stbl", &stbl));
        be_box(b"minf", &m)
    };
    let mdia = {
        let mut m = mdhd(track.rate, media)?;
        m.extend(hdlr(b"soun", "SoundHandler"));
        m.extend(minf);
        be_box(b"mdia", &m)
    };
    body.extend(mdia);
    Ok(be_box(b"trak", &body))
}

fn ftyp() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(b"isom");
    body.extend_from_slice(&0u32.to_be_bytes());
    body.extend_from_slice(b"isomiso2avc1mp41");
    be_box(b"ftyp", &body)
}

fn mvhd(duration: u64, next_track: u32) -> Result<Vec<u8>, &'static str> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&TIMESCALES.to_be_bytes());
    payload.extend_from_slice(&fit_u32(duration)?.to_be_bytes());
    payload.extend_from_slice(&0x00010000u32.to_be_bytes());
    payload.extend_from_slice(&0x0100u16.to_be_bytes());
    payload.extend_from_slice(&[0u8; 10]);
    matrix(&mut payload);
    payload.extend_from_slice(&[0u8; 24]);
    payload.extend_from_slice(&next_track.to_be_bytes());
    Ok(full(b"mvhd", 0, &payload))
}

fn tkhd(track_id: u32, duration: u64, volume: u16, width: u32, height: u32) -> Result<Vec<u8>, &'static str> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&track_id.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&fit_u32(duration)?.to_be_bytes());
    payload.extend_from_slice(&[0u8; 8]);
    payload.extend_from_slice(&0u16.to_be_bytes());
    payload.extend_from_slice(&0u16.to_be_bytes());
    payload.extend_from_slice(&volume.to_be_bytes());
    payload.extend_from_slice(&0u16.to_be_bytes());
    matrix(&mut payload);
    payload.extend_from_slice(&(width << 16).to_be_bytes());
    payload.extend_from_slice(&(height << 16).to_be_bytes());
    Ok(full(b"tkhd", 7, &payload))
}

fn elst(delay: u64, media_movie: u64) -> Result<Option<Vec<u8>>, &'static str> {
    if delay == 0 {
        return Ok(None);
    }
    let mut payload = Vec::new();
    payload.extend_from_slice(&2u32.to_be_bytes());
    payload.extend_from_slice(&fit_u32(delay)?.to_be_bytes());
    payload.extend_from_slice(&0xFFFFFFFFu32.to_be_bytes());
    payload.extend_from_slice(&0x00010000u32.to_be_bytes());
    payload.extend_from_slice(&fit_u32(media_movie)?.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&0x00010000u32.to_be_bytes());
    let elst = full(b"elst", 0, &payload);
    Ok(Some(be_box(b"edts", &elst)))
}

fn mdhd(timescale: u32, duration: u64) -> Result<Vec<u8>, &'static str> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&fit_u32(duration)?.to_be_bytes());
    payload.extend_from_slice(&0x55C4u16.to_be_bytes());
    payload.extend_from_slice(&0u16.to_be_bytes());
    Ok(full(b"mdhd", 0, &payload))
}

fn hdlr(kind: &[u8; 4], name: &str) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(kind);
    payload.extend_from_slice(&[0u8; 12]);
    payload.extend_from_slice(name.as_bytes());
    payload.push(0);
    full(b"hdlr", 0, &payload)
}

fn vmhd() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u16.to_be_bytes());
    payload.extend_from_slice(&[0u8; 6]);
    full(b"vmhd", 1, &payload)
}

fn smhd() -> Vec<u8> {
    full(b"smhd", 0, &[0, 0, 0, 0])
}

fn dinf() -> Vec<u8> {
    let url = full(b"url ", 1, &[]);
    let mut payload = Vec::new();
    payload.extend_from_slice(&1u32.to_be_bytes());
    payload.extend(url);
    be_box(b"dinf", &full(b"dref", 0, &payload))
}

fn stsd(entry: &[u8]) -> Vec<u8> {
    // full() 已经写了 version/flags。这里再补一个 0 会把 entry_count 挤成 0，
    // 样本描述还在文件里，但播放器认为没有视频轨，iOS 直接报无法播放。
    let mut payload = Vec::new();
    payload.extend_from_slice(&1u32.to_be_bytes());
    payload.extend_from_slice(entry);
    full(b"stsd", 0, &payload)
}

fn avc1(video: &VideoBuilt) -> Result<Vec<u8>, &'static str> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0u8; 6]);
    body.extend_from_slice(&1u16.to_be_bytes());
    body.extend_from_slice(&0u16.to_be_bytes());
    body.extend_from_slice(&0u16.to_be_bytes());
    body.extend_from_slice(&[0u8; 12]);
    body.extend_from_slice(&(video.width as u16).to_be_bytes());
    body.extend_from_slice(&(video.height as u16).to_be_bytes());
    body.extend_from_slice(&0x00480000u32.to_be_bytes());
    body.extend_from_slice(&0x00480000u32.to_be_bytes());
    body.extend_from_slice(&0u32.to_be_bytes());
    body.extend_from_slice(&1u16.to_be_bytes());
    body.extend_from_slice(&[0u8; 32]);
    body.extend_from_slice(&0x0018u16.to_be_bytes());
    body.extend_from_slice(&0xFFFFu16.to_be_bytes());
    body.extend(avcc(&video.sps, &video.pps)?);
    Ok(be_box(b"avc1", &body))
}

fn avcc(sps_list: &[Vec<u8>], pps_list: &[Vec<u8>]) -> Result<Vec<u8>, &'static str> {
    let sps = sps_list.first().ok_or("缺少 SPS 或 PPS")?;
    let mut body = vec![
        1,
        sps.get(1).copied().unwrap_or(0x42),
        sps.get(2).copied().unwrap_or(0),
        sps.get(3).copied().unwrap_or(0x1E),
        0xFF,
        0xE0 | (sps_list.len().min(31) as u8),
    ];
    for sps in sps_list.iter().take(31) {
        body.extend_from_slice(&(sps.len() as u16).to_be_bytes());
        body.extend_from_slice(sps);
    }
    body.push(pps_list.len().min(255) as u8);
    for pps in pps_list.iter().take(255) {
        body.extend_from_slice(&(pps.len() as u16).to_be_bytes());
        body.extend_from_slice(pps);
    }
    Ok(be_box(b"avcC", &body))
}

fn mp4a(track: &AudioBuilt) -> Result<Vec<u8>, &'static str> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0u8; 6]);
    body.extend_from_slice(&1u16.to_be_bytes());
    body.extend_from_slice(&0u16.to_be_bytes());
    body.extend_from_slice(&0u16.to_be_bytes());
    body.extend_from_slice(&0u32.to_be_bytes());
    body.extend_from_slice(&(track.channels as u16).to_be_bytes());
    body.extend_from_slice(&16u16.to_be_bytes());
    body.extend_from_slice(&0u16.to_be_bytes());
    body.extend_from_slice(&0u16.to_be_bytes());
    body.extend_from_slice(&(track.rate << 16).to_be_bytes());
    let bytes: usize = track.frames.iter().map(|frame| frame.len()).sum();
    let avg = if track.frames.is_empty() {
        0
    } else {
        ((bytes as u64) * 8 * track.rate as u64 / (track.frames.len() as u64 * 1024)) as u32
    };
    body.extend(esds(track.aot, track.freq_index, track.channels, avg));
    Ok(be_box(b"mp4a", &body))
}

fn esds(aot: u8, freq_index: u8, channels: u8, avg_bps: u32) -> Vec<u8> {
    let value = ((aot as u16) << 11) | ((freq_index as u16) << 7) | ((channels as u16) << 3);
    let asc = [(value >> 8) as u8, (value & 0xFF) as u8];
    let dsi = descriptor(0x05, &asc);
    let mut decoder = Vec::new();
    decoder.push(0x40);
    decoder.push(0x15);
    decoder.extend_from_slice(&[0, 0, 0]);
    decoder.extend_from_slice(&avg_bps.to_be_bytes());
    decoder.extend_from_slice(&avg_bps.to_be_bytes());
    decoder.extend(dsi);
    let decoder = descriptor(0x04, &decoder);
    let sl = descriptor(0x06, &[0x02]);
    let mut es = Vec::new();
    es.extend_from_slice(&1u16.to_be_bytes());
    es.push(0);
    es.extend(decoder);
    es.extend(sl);
    let es = descriptor(0x03, &es);
    full(b"esds", 0, &es)
}

fn descriptor(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    out.push(tag);
    let mut size = payload.len();
    let mut parts = [0u8; 4];
    let mut n = 0;
    loop {
        parts[n] = (size & 0x7F) as u8;
        size >>= 7;
        n += 1;
        if size == 0 || n == 4 {
            break;
        }
    }
    for i in (0..n).rev() {
        let cont = if i == 0 { 0 } else { 0x80 };
        out.push(parts[i] | cont);
    }
    out.extend_from_slice(payload);
    out
}

fn stts(deltas: &[u32]) -> Vec<u8> {
    let mut entries: Vec<(u32, u32)> = Vec::new();
    for &delta in deltas {
        if let Some(last) = entries.last_mut() {
            if last.1 == delta {
                last.0 = last.0.saturating_add(1);
                continue;
            }
        }
        entries.push((1, delta));
    }
    let mut payload = Vec::new();
    payload.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (count, delta) in entries {
        payload.extend_from_slice(&count.to_be_bytes());
        payload.extend_from_slice(&delta.to_be_bytes());
    }
    full(b"stts", 0, &payload)
}

fn ctts(offsets: &[u32]) -> Vec<u8> {
    let mut entries: Vec<(u32, u32)> = Vec::new();
    for &offset in offsets {
        if let Some(last) = entries.last_mut() {
            if last.1 == offset {
                last.0 = last.0.saturating_add(1);
                continue;
            }
        }
        entries.push((1, offset));
    }
    let mut payload = Vec::new();
    payload.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (count, offset) in entries {
        payload.extend_from_slice(&count.to_be_bytes());
        payload.extend_from_slice(&offset.to_be_bytes());
    }
    full(b"ctts", 0, &payload)
}

fn stss(keys: &[u32]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&(keys.len() as u32).to_be_bytes());
    for key in keys {
        payload.extend_from_slice(&key.to_be_bytes());
    }
    full(b"stss", 0, &payload)
}

fn stsc(sample_count: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&1u32.to_be_bytes());
    payload.extend_from_slice(&1u32.to_be_bytes());
    payload.extend_from_slice(&sample_count.to_be_bytes());
    payload.extend_from_slice(&1u32.to_be_bytes());
    full(b"stsc", 0, &payload)
}

fn stsz(sizes: &[u32]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&(sizes.len() as u32).to_be_bytes());
    for size in sizes {
        payload.extend_from_slice(&size.to_be_bytes());
    }
    full(b"stsz", 0, &payload)
}

fn chunk_offset(offset: u64, wide: bool) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&1u32.to_be_bytes());
    if wide {
        payload.extend_from_slice(&offset.to_be_bytes());
        full(b"co64", 0, &payload)
    } else {
        payload.extend_from_slice(&(offset as u32).to_be_bytes());
        full(b"stco", 0, &payload)
    }
}

fn matrix(out: &mut Vec<u8>) {
    for value in [0x00010000u32, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000] {
        out.extend_from_slice(&value.to_be_bytes());
    }
}

fn full(kind: &[u8; 4], flags: u32, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(4 + payload.len());
    body.extend_from_slice(&flags.to_be_bytes());
    body.extend_from_slice(payload);
    be_box(kind, &body)
}

fn be_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&((8 + body.len()) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    bit: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0, bit: 0 }
    }

    fn read_bit(&mut self) -> Option<u8> {
        if self.pos >= self.data.len() {
            return None;
        }
        let bit = (self.data[self.pos] >> (7 - self.bit)) & 1;
        self.bit += 1;
        if self.bit == 8 {
            self.bit = 0;
            self.pos += 1;
        }
        Some(bit)
    }
}

fn ue(bits: &mut BitReader) -> Option<u32> {
    let mut zeros = 0u32;
    loop {
        if bits.read_bit()? == 1 {
            break;
        }
        zeros += 1;
        if zeros > 31 {
            return None;
        }
    }
    let mut value = 1u32;
    for _ in 0..zeros {
        value = (value << 1) | bits.read_bit()? as u32;
    }
    Some(value - 1)
}

fn se(bits: &mut BitReader) -> Option<i32> {
    let code = ue(bits)?;
    let magnitude = ((code + 1) / 2) as i32;
    if code & 1 == 0 { Some(-magnitude) } else { Some(magnitude) }
}

fn strip_epb(rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rbsp.len());
    let mut zeros = 0u8;
    for &byte in rbsp {
        if zeros >= 2 && byte == 0x03 {
            zeros = 0;
            continue;
        }
        out.push(byte);
        if byte == 0 {
            zeros = zeros.saturating_add(1);
        } else {
            zeros = 0;
        }
    }
    out
}

pub(crate) fn sps_dimensions(nal: &[u8]) -> Option<(u32, u32)> {
    if nal.first().copied().unwrap_or(0) & 0x1F != 7 {
        return None;
    }
    let rbsp = strip_epb(&nal[1..]);
    if rbsp.len() < 4 {
        return None;
    }
    let profile = rbsp[0];
    let mut bits = BitReader::new(&rbsp[3..]);
    let _ = ue(&mut bits)?;
    let mut chroma = 1u32;
    let mut separate = false;
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
        chroma = ue(&mut bits)?;
        if chroma == 3 {
            separate = bits.read_bit()? == 1;
        }
        let _ = ue(&mut bits)?;
        let _ = ue(&mut bits)?;
        let _ = bits.read_bit()?;
        if bits.read_bit()? == 1 {
            let count = if chroma != 3 { 8 } else { 12 };
            for i in 0..count {
                if bits.read_bit()? == 1 {
                    skip_scaling_list(&mut bits, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    let _ = ue(&mut bits)?;
    let poc = ue(&mut bits)?;
    if poc == 0 {
        let _ = ue(&mut bits)?;
    } else if poc == 1 {
        let _ = bits.read_bit()?;
        let _ = se(&mut bits)?;
        let _ = se(&mut bits)?;
        let cycles = ue(&mut bits)? as usize;
        if cycles > 256 {
            return None;
        }
        for _ in 0..cycles {
            let _ = se(&mut bits)?;
        }
    } else if poc > 2 {
        return None;
    }
    let _ = ue(&mut bits)?;
    let _ = bits.read_bit()?;
    let width_mbs = ue(&mut bits)?.checked_add(1)?;
    let height_map = ue(&mut bits)?.checked_add(1)?;
    let frame_mbs_only = bits.read_bit()?;
    if frame_mbs_only == 0 {
        let _ = bits.read_bit()?;
    }
    let _ = bits.read_bit()?;
    let mut crop_l = 0u32;
    let mut crop_r = 0u32;
    let mut crop_t = 0u32;
    let mut crop_b = 0u32;
    if bits.read_bit()? == 1 {
        crop_l = ue(&mut bits)?;
        crop_r = ue(&mut bits)?;
        crop_t = ue(&mut bits)?;
        crop_b = ue(&mut bits)?;
    }
    let frame = frame_mbs_only as u32;
    let chroma_array = if separate { 0 } else { chroma };
    let (crop_x, crop_y) = if chroma_array == 0 {
        (1, 2 - frame)
    } else {
        let (sub_w, sub_h) = match chroma_array {
            2 => (2, 1),
            3 => (1, 1),
            _ => (2, 2),
        };
        (sub_w, sub_h * (2 - frame))
    };
    let width = width_mbs.checked_mul(16)?.checked_sub((crop_l.saturating_add(crop_r)).saturating_mul(crop_x))?;
    let height = height_map
        .checked_mul(2 - frame)?
        .checked_mul(16)?
        .checked_sub((crop_t.saturating_add(crop_b)).saturating_mul(crop_y))?;
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return None;
    }
    Some((width, height))
}

fn skip_scaling_list(bits: &mut BitReader, size: usize) -> Option<()> {
    let mut last = 8i32;
    let mut next = 8i32;
    for _ in 0..size {
        if next != 0 {
            let delta = se(bits)?;
            next = (last + delta).rem_euclid(256);
        }
        last = if next == 0 { last } else { next };
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_sps_is_320x240() {
        let nal = [0x67, 0x42, 0x00, 0x1E, 0xF4, 0x0A, 0x0F, 0xD0];
        assert_eq!(sps_dimensions(&nal), Some((320, 240)));
    }

    #[test]
    fn high_profile_sps_is_320x240() {
        let nal = [0x67, 0x64, 0x00, 0x1F, 0xAC, 0xE8, 0x14, 0x1F, 0xA0];
        assert_eq!(sps_dimensions(&nal), Some((320, 240)));
    }

    #[test]
    fn h264_aac_ts_becomes_mp4() {
        let sps = [0x67, 0x42, 0x00, 0x1E, 0xF4, 0x0A, 0x0F, 0xD0];
        let pps = [0x68, 0xEE, 0x38, 0x80];
        let idr = [0x65, 0x88, 0x84, 0x00, 0x01];
        let mut ts = Vec::new();
        ts.extend(packets(0x0000, &pat(), true));
        ts.extend(packets(0x0100, &pmt(&[(0x1B, 0x0101), (0x0F, 0x0102)]), true));
        ts.extend(packets(0x0101, &pes(0xE0, 0, &annex(&[&sps, &pps, &idr])), false));
        ts.extend(packets(0x0102, &pes(0xC0, 0, &adts_frame(&[0x11, 0x22, 0x33, 0x44])), false));

        let mp4 = remux_ts(&ts).expect("remux");
        assert_eq!(&mp4[4..8], b"ftyp");
        assert!(mp4.windows(4).any(|w| w == b"mdat"));
        assert!(mp4.windows(4).any(|w| w == b"avcC"));
        assert!(mp4.windows(4).any(|w| w == b"mp4a"));
        // ftyp 的兼容品牌里也有 avc1，样本入口是后面那个盒子。
        let avc1 = mp4.windows(4).rposition(|w| w == b"avc1").expect("avc1");
        let width = u16::from_be_bytes([mp4[avc1 + 28], mp4[avc1 + 29]]);
        let height = u16::from_be_bytes([mp4[avc1 + 30], mp4[avc1 + 31]]);
        assert_eq!((width, height), (320, 240));
        assert!(mp4.windows(9).any(|w| w == [0, 0, 0, 5, 0x65, 0x88, 0x84, 0x00, 0x01]));
        let mut from = 0;
        let mut descriptions = 0;
        while let Some(rel) = mp4[from..].windows(4).position(|word| word == b"stsd") {
            let pos = from + rel;
            let count = u32::from_be_bytes(mp4[pos + 8..pos + 12].try_into().unwrap());
            assert_eq!(count, 1, "stsd entry_count");
            descriptions += 1;
            from = pos + 4;
        }
        assert_eq!(descriptions, 2);
        let mvhd = mp4.windows(4).position(|w| w == b"mvhd").expect("mvhd");
        let timescale = u32::from_be_bytes(mp4[mvhd + 16..mvhd + 20].try_into().unwrap());
        let duration = u32::from_be_bytes(mp4[mvhd + 20..mvhd + 24].try_into().unwrap());
        assert_eq!(timescale, 90_000);
        assert!(duration >= 3000, "{duration}");
    }

    #[test]
    fn ffmpeg_transport_stream_decodes_as_mp4() {
        let version = match std::process::Command::new("ffmpeg").arg("-version").output() {
            Ok(output) if output.status.success() => output,
            _ => return,
        };
        let _ = version;
        let dir = std::env::temp_dir().join(format!("hg-remux-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ts_path = dir.join("in.ts");
        let mp4_path = dir.join("out.mp4");
        let encoded = std::process::Command::new("ffmpeg")
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=1",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high",
                "-g", "25", "-bf", "2",
                "-c:a", "aac", "-b:a", "64k",
                "-shortest", "-f", "mpegts",
            ])
            .arg(&ts_path)
            .output()
            .expect("ffmpeg");
        if !encoded.status.success() {
            let _ = std::fs::remove_dir_all(&dir);
            eprintln!("skip ffmpeg roundtrip: {}", String::from_utf8_lossy(&encoded.stderr));
            return;
        }
        let ts = std::fs::read(&ts_path).unwrap();
        let mp4 = remux_ts(&ts).expect("remux");
        std::fs::write(&mp4_path, &mp4).unwrap();
        let probe = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0"])
            .arg(&mp4_path)
            .output()
            .expect("ffprobe");
        let info = format!(
            "{}\n{}",
            String::from_utf8_lossy(&probe.stdout),
            String::from_utf8_lossy(&probe.stderr)
        );
        assert!(probe.status.success(), "{info}");
        assert!(info.contains("h264"), "{info}");
        assert!(info.contains("320,240") || info.contains("320, 240"), "{info}");
        assert!(info.contains("aac"), "{info}");
        let decoded = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(&mp4_path)
            .args(["-f", "null", "-"])
            .output()
            .expect("decode");
        assert!(
            decoded.status.success(),
            "{}",
            String::from_utf8_lossy(&decoded.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hevc_and_garbage_stay_unmuxed() {
        let mut ts = Vec::new();
        ts.extend(packets(0x0000, &pat(), true));
        ts.extend(packets(0x0100, &pmt(&[(0x24, 0x0101)]), true));
        assert_eq!(remux_ts(&ts).unwrap_err(), "只有 HEVC，不能转成 mp4");
        assert!(remux_ts(b"not a transport stream").is_err());
    }

    fn annex(nals: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for nal in nals {
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(nal);
        }
        out
    }

    fn pat() -> Vec<u8> {
        vec![
            0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xE1, 0x00, 0, 0, 0, 0,
        ]
    }

    fn pmt(streams: &[(u8, u16)]) -> Vec<u8> {
        let mut after = Vec::new();
        after.extend_from_slice(&1u16.to_be_bytes());
        after.push(0xC1);
        after.push(0);
        after.push(0);
        after.extend_from_slice(&0xE101u16.to_be_bytes());
        after.extend_from_slice(&0xF000u16.to_be_bytes());
        for (stream_type, pid) in streams {
            after.push(*stream_type);
            after.extend_from_slice(&(0xE000 | pid).to_be_bytes());
            after.extend_from_slice(&0xF000u16.to_be_bytes());
        }
        after.extend_from_slice(&[0, 0, 0, 0]);
        let mut section = vec![0x02, 0xB0 | ((after.len() >> 8) as u8), (after.len() & 0xFF) as u8];
        section.extend(after);
        section
    }

    fn pes(stream_id: u8, pts: u64, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0, 0, 1, stream_id];
        let packet_len = 8 + payload.len();
        out.extend_from_slice(&(packet_len as u16).to_be_bytes());
        out.extend_from_slice(&[0x80, 0x80, 5]);
        let p = pts & 0x1FFFFFFFF;
        out.push(0x21 | (((p >> 30) as u8) << 1));
        out.push(((p >> 22) & 0xFF) as u8);
        out.push((((p >> 15) & 0x7F) as u8) << 1 | 1);
        out.push(((p >> 7) & 0xFF) as u8);
        out.push(((p & 0x7F) as u8) << 1 | 1);
        out.extend_from_slice(payload);
        out
    }

    fn adts_frame(payload: &[u8]) -> Vec<u8> {
        let frame_len = 7 + payload.len();
        let mut bits = Vec::new();
        bits.extend(std::iter::repeat(1).take(12));
        bits.push(1);
        bits.extend([0, 0, 1]);
        bits.extend([0, 1]);
        bits.extend([0, 1, 0, 0]);
        bits.push(0);
        bits.extend([0, 1, 0]);
        bits.extend([0, 0, 0, 0]);
        for shift in (0..13).rev() {
            bits.push(((frame_len >> shift) & 1) as u8);
        }
        bits.extend(std::iter::repeat(1).take(11));
        bits.extend([0, 0]);
        let mut header = Vec::new();
        let mut cur = 0u8;
        let mut n = 0;
        for bit in bits {
            cur = (cur << 1) | bit;
            n += 1;
            if n == 8 {
                header.push(cur);
                cur = 0;
                n = 0;
            }
        }
        header.extend_from_slice(payload);
        header
    }

    fn packets(pid: u16, payload: &[u8], pointer: bool) -> Vec<u8> {
        let mut data = Vec::new();
        if pointer {
            data.push(0);
        }
        data.extend_from_slice(payload);
        let mut out = Vec::new();
        let mut offset = 0;
        let mut cc = 0u8;
        let mut first = true;
        while offset < data.len() {
            let n = (data.len() - offset).min(184);
            out.extend(ts_packet(pid, first, cc, &data[offset..offset + n]));
            first = false;
            cc = (cc + 1) & 0x0F;
            offset += n;
        }
        out
    }

    fn ts_packet(pid: u16, pusi: bool, cc: u8, payload: &[u8]) -> [u8; 188] {
        let mut pkt = [0xFFu8; 188];
        pkt[0] = 0x47;
        pkt[1] = ((pid >> 8) as u8 & 0x1F) | if pusi { 0x40 } else { 0 };
        pkt[2] = pid as u8;
        let stuff = 184 - payload.len();
        if stuff == 0 {
            pkt[3] = 0x10 | (cc & 0x0F);
            pkt[4..].copy_from_slice(payload);
        } else {
            pkt[3] = 0x30 | (cc & 0x0F);
            let af_len = stuff - 1;
            pkt[4] = af_len as u8;
            if af_len > 0 {
                pkt[5] = 0;
            }
            let at = 5 + af_len;
            pkt[at..at + payload.len()].copy_from_slice(payload);
        }
        pkt
    }
}
