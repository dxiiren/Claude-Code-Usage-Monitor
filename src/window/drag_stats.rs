//! Counters for the drag path, so a drag can be measured instead of judged by eye.
//! They are always counted (a relaxed atomic add) and only written out when the
//! `CCUM_DRAG_STATS` environment variable names a file.

use std::sync::atomic::{AtomicU32, Ordering};

pub(super) static RENDERS: AtomicU32 = AtomicU32::new(0);
pub(super) static PAINTS: AtomicU32 = AtomicU32::new(0);
pub(super) static SETTINGS_WRITES: AtomicU32 = AtomicU32::new(0);
pub(super) static MOVES_SEEN: AtomicU32 = AtomicU32::new(0);
pub(super) static MOVES_APPLIED: AtomicU32 = AtomicU32::new(0);
pub(super) static MOVE_MICROS: AtomicU32 = AtomicU32::new(0);

pub(super) fn bump(counter: &AtomicU32) {
    counter.fetch_add(1, Ordering::Relaxed);
}

pub(super) fn reset() {
    for counter in [&RENDERS, &PAINTS, &SETTINGS_WRITES, &MOVES_SEEN, &MOVES_APPLIED, &MOVE_MICROS] {
        counter.store(0, Ordering::Relaxed);
    }
}

pub(super) fn report(label: &str) {
    let line = format!(
        "{label} moves_seen={} moves_applied={} renders={} paints={} settings_writes={} move_handler_ms={}\n",
        MOVES_SEEN.load(Ordering::Relaxed),
        MOVES_APPLIED.load(Ordering::Relaxed),
        RENDERS.load(Ordering::Relaxed),
        PAINTS.load(Ordering::Relaxed),
        SETTINGS_WRITES.load(Ordering::Relaxed),
        MOVE_MICROS.load(Ordering::Relaxed) / 1000,
    );
    crate::diagnose::log(line.trim_end());
    if let Some(path) = std::env::var_os("CCUM_DRAG_STATS") {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

/// Message and placement trace for diagnosing a real-mouse drag. Off unless the
/// `CCUM_DRAG_TRACE` environment variable names a file; one line per event with
/// a millisecond timestamp.
pub(super) fn trace(line: impl FnOnce() -> String) {
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};
    static SINK: OnceLock<Option<Mutex<(std::fs::File, std::time::Instant)>>> = OnceLock::new();
    let sink = SINK.get_or_init(|| {
        let path = std::env::var_os("CCUM_DRAG_TRACE")?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()?;
        Some(Mutex::new((file, std::time::Instant::now())))
    });
    if let Some(sink) = sink {
        if let Ok(mut guard) = sink.lock() {
            let ms = guard.1.elapsed().as_millis();
            let _ = writeln!(guard.0, "{ms:>8} {}", line());
        }
    }
}
