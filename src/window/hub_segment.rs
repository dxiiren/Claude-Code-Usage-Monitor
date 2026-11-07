//! Where the Agent Hub segment sits on the taskbar: a surface whose placement
//! reference is `traffic_monitor`, put right after the TrafficMonitor tool's own
//! taskbar window. Everything here only reads other windows' rectangles: the
//! traffic monitor is never moved, resized or touched.
use super::*;

/// The window title TrafficMonitor gives its taskbar-embedded window.
const TRAFFIC_MONITOR_TITLE: &str = "TrafficMonitorTaskbarWindow";
/// Logical px kept between the segment and its neighbours.
const GAP_LOGICAL: f64 = 3.0;

/// Rectangles read from one taskbar (screen px).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Anchors {
    /// The notification area (clock, tray icons).
    pub tray: Option<RECT>,
    /// The traffic monitor's window, when it is running and docked in this taskbar.
    pub traffic_monitor: Option<RECT>,
    /// Right edge of the app buttons that lie left of the traffic monitor.
    pub buttons_right: Option<i32>,
    /// Left edge of the first app control (the fallback segment must stay left of it).
    pub controls_left: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Side {
    /// Right after the traffic monitor (the wanted place).
    Right,
    /// Flush to the traffic monitor's left edge: its right edge touches the
    /// notification area, so there is no space after it.
    Left,
    /// No traffic monitor: right after the account strip.
    Strip,
}

/// A free span of the taskbar in screen px.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Span {
    pub side: Side,
    pub left: i32,
    pub right: i32,
}

impl Span {
    pub fn width(self) -> i32 {
        (self.right - self.left).max(0)
    }

    /// The segment's left edge for a window `width` px wide: against the traffic
    /// monitor's edge, never beyond the span.
    pub fn origin(self, width: i32) -> i32 {
        match self.side {
            Side::Left => self.right - width.min(self.width()),
            Side::Right | Side::Strip => self.left,
        }
    }
}

/// The span the segment may fill. With the traffic monitor running: the space
/// right after it, else (when that cannot hold `min_px`) the space left of it
/// down to the app buttons and the account strip, else whichever is larger.
/// Without it: the space after the account strip up to the first app control.
pub(super) fn free_span(
    taskbar: RECT,
    anchors: &Anchors,
    strip: Option<RECT>,
    scale: f64,
    min_px: i32,
) -> Option<Span> {
    let gap = (GAP_LOGICAL * scale).round() as i32;
    let strip_right = strip.map(|s| s.right);
    let span = |side, left: i32, right: i32| Span { side, left, right };
    let spans = if let Some(tm) = anchors.traffic_monitor {
        let after = span(
            Side::Right,
            tm.right + gap,
            anchors.tray.map_or(taskbar.right, |t| t.left),
        );
        let floor = anchors
            .buttons_right
            .unwrap_or(taskbar.left)
            .max(strip_right.unwrap_or(taskbar.left));
        let before = span(Side::Left, floor + gap, tm.left - gap);
        if after.width() >= min_px {
            vec![after]
        } else if before.width() >= min_px {
            vec![before]
        } else {
            vec![after, before]
        }
    } else {
        let left = strip_right.map_or(taskbar.left, |r| r + gap);
        let right = anchors.controls_left.unwrap_or(taskbar.right);
        vec![span(Side::Strip, left, right)]
    };
    spans.into_iter().max_by_key(|s| s.width())
}

/// Logical px the layout may use in `span` at `scale` (0 when there is none).
pub(super) fn room_logical(span: Option<Span>, scale: f64) -> u32 {
    span.map_or(0, |s| (s.width() as f64 / scale.max(0.01)).floor() as u32)
}

fn traffic_monitor_window(taskbar: HWND) -> Option<HWND> {
    unsafe {
        let title = native_interop::wide_str(TRAFFIC_MONITOR_TITLE);
        FindWindowExW(
            Some(taskbar),
            None,
            PCWSTR::null(),
            PCWSTR::from_raw(title.as_ptr()),
        )
        .ok()
        .filter(|h| *h != HWND::default() && IsWindowVisible(*h).as_bool())
    }
}

/// Read-only query of the neighbours on one taskbar (taskbar rect `bounds`).
pub(super) fn query_anchors(taskbar: HWND, bounds: RECT) -> Anchors {
    let rect_of = |class: &str| {
        native_interop::find_child_window(taskbar, class)
            .and_then(native_interop::get_window_rect_safe)
    };
    let tray = rect_of("TrayNotifyWnd");
    let traffic_monitor = traffic_monitor_window(taskbar)
        .and_then(native_interop::get_window_rect_safe)
        .filter(|r| r.right > r.left && r.bottom > r.top);
    // Prefer what the accessibility tree saw (Windows 11 draws its buttons outside
    // any window of its own); the rebar rectangle is the stale-cache fallback.
    let rebar = rect_of("ReBarWindow32");
    let probe = traffic_monitor.unwrap_or(RECT {
        left: bounds.right,
        right: bounds.right,
        ..bounds
    });
    let (mut buttons_right, mut controls_left) = (rebar.map(|r| r.right), rebar.map(|r| r.left));
    if let Some(occupancy) = taskbar_collision::cached(taskbar, bounds) {
        let lane = |item: &&RECT| item.top < probe.bottom && probe.top < item.bottom;
        let buttons = occupancy
            .occupied
            .iter()
            .filter(lane)
            .filter(|item| !occupancy.is_reserved(**item))
            .filter(|item| item.right <= probe.left + 2);
        buttons_right = buttons
            .clone()
            .map(|item| item.right)
            .max()
            .or(buttons_right);
        controls_left = buttons.map(|item| item.left).min().or(controls_left);
    }
    Anchors {
        tray,
        traffic_monitor,
        buttons_right,
        controls_left,
    }
}

/// Whether the theme has a segment at all (the timer's watch costs nothing without one).
static ACTIVE: AtomicBool = AtomicBool::new(false);

pub(super) fn set_active(active: bool) {
    ACTIVE.store(active, Ordering::Relaxed);
}

/// Per display: the taskbar and the neighbours read from it at the last refresh.
static ANCHORS: Mutex<Vec<Option<(RECT, Anchors)>>> = Mutex::new(Vec::new());

/// Read every display's taskbar again; true when anything the segment is placed
/// against moved (the traffic monitor started, stopped, moved or resized, the
/// buttons grew, the taskbar changed).
pub(super) fn refresh_anchors() -> bool {
    if !ACTIVE.load(Ordering::Relaxed) {
        return false;
    }
    let displays = native_interop::find_monitors();
    let taskbars = native_interop::find_taskbars();
    let fresh: Vec<Option<(RECT, Anchors)>> = displays
        .iter()
        .map(|display| {
            taskbars
                .iter()
                .find(|taskbar| unsafe {
                    MonitorFromWindow(taskbar.hwnd, MONITOR_DEFAULTTOPRIMARY) == display.handle
                })
                .map(|taskbar| (taskbar.rect, query_anchors(taskbar.hwnd, taskbar.rect)))
        })
        .collect();
    let mut cached = ANCHORS.lock().unwrap_or_else(|e| e.into_inner());
    let changed = *cached != fresh;
    *cached = fresh;
    changed
}

/// The span for the segment of `display` at `scale` (physical px per logical px),
/// from the last `refresh_anchors` and the strip's last rectangle.
pub(super) fn span_for(display: usize, scale: f64) -> Option<Span> {
    let (taskbar, anchors) = ANCHORS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(display)
        .copied()
        .flatten()?;
    let min_px = (crate::widget_filter::HUB_COMPACT_W as f64 * scale).round() as i32;
    free_span(taskbar, &anchors, strip(), scale, min_px)
}

/// The primary strip's last placed rectangle: the segment never overlaps it and,
/// without a traffic monitor, sits right after it.
static STRIP: Mutex<Option<RECT>> = Mutex::new(None);

pub(super) fn set_strip(rect: Option<RECT>) {
    *STRIP.lock().unwrap_or_else(|e| e.into_inner()) = rect;
}

pub(super) fn strip() -> Option<RECT> {
    *STRIP.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, right: i32) -> RECT {
        RECT {
            left,
            top: 1528,
            right,
            bottom: 1600,
        }
    }

    // The owner's 2560 px taskbar at 150%: strip 50..941, buttons to 1565,
    // traffic monitor 1875..2163 touching the notification area at 2161.
    fn owner() -> (RECT, Anchors, Option<RECT>) {
        (
            rect(0, 2560),
            Anchors {
                tray: Some(rect(2161, 2560)),
                traffic_monitor: Some(rect(1875, 2163)),
                buttons_right: Some(1565),
                controls_left: Some(981),
            },
            Some(rect(50, 941)),
        )
    }

    #[test]
    fn right_after_the_traffic_monitor_when_there_is_room() {
        let (taskbar, mut anchors, strip) = owner();
        anchors.tray = Some(rect(2563, 2900)); // a tray far to the right
        let span = free_span(taskbar, &anchors, strip, 1.5, 117).unwrap();
        assert_eq!(span.side, Side::Right);
        assert_eq!(span.left, 2163 + 5, "starts a gap after the monitor");
        assert_eq!(span.origin(300), span.left);
    }

    #[test]
    fn flush_left_of_the_monitor_when_it_touches_the_notification_area() {
        let (taskbar, anchors, strip) = owner();
        let span = free_span(taskbar, &anchors, strip, 1.5, 117).unwrap();
        assert_eq!(span.side, Side::Left);
        assert_eq!((span.left, span.right), (1565 + 5, 1875 - 5));
        // the window ends exactly at the monitor's edge, never over the buttons
        let width = 250;
        let x = span.origin(width);
        assert_eq!(x + width, span.right);
        assert!(x >= span.left);
        // a window wider than the span is held inside it
        assert_eq!(span.origin(10_000), span.left);
        assert_eq!(room_logical(Some(span), 1.5), 200);
    }

    #[test]
    fn never_overlaps_the_strip_or_the_buttons() {
        let (taskbar, mut anchors, _) = owner();
        anchors.buttons_right = Some(500);
        let strip = Some(rect(50, 1700));
        let span = free_span(taskbar, &anchors, strip, 1.0, 78).unwrap();
        assert_eq!(
            span.left,
            1700 + 3,
            "the strip is a floor as well as the buttons"
        );
    }

    #[test]
    fn follows_the_monitor_when_it_moves() {
        let (taskbar, mut anchors, strip) = owner();
        let before = free_span(taskbar, &anchors, strip, 1.5, 117).unwrap();
        anchors.traffic_monitor = Some(rect(1700, 1988));
        let after = free_span(taskbar, &anchors, strip, 1.5, 117).unwrap();
        // the monitor moved 175 px left; its right side is now wide open
        assert_eq!(before.side, Side::Left);
        assert_eq!(after.side, Side::Right);
        assert_eq!(after.left, 1988 + 5);
    }

    #[test]
    fn without_a_traffic_monitor_it_follows_the_account_strip() {
        let (taskbar, mut anchors, strip) = owner();
        anchors.traffic_monitor = None;
        let span = free_span(taskbar, &anchors, strip, 1.5, 117).unwrap();
        assert_eq!(span.side, Side::Strip);
        assert_eq!(span.left, 941 + 5);
        assert_eq!(span.right, 981, "up to the first app control");
        assert_eq!(span.origin(10_000), span.left);
        // no strip yet: starts at the taskbar's left edge
        let none = free_span(taskbar, &anchors, None, 1.5, 117).unwrap();
        assert_eq!(none.left, 0);
    }

    #[test]
    fn the_larger_side_wins_when_neither_holds_the_minimum() {
        let (taskbar, mut anchors, strip) = owner();
        anchors.buttons_right = Some(1800); // only 70 px left of the monitor
        let span = free_span(taskbar, &anchors, strip, 1.5, 400).unwrap();
        assert_eq!(
            span.side,
            Side::Left,
            "right of the monitor is 0 px, left is 65 px"
        );
        assert_eq!(span.width(), 65);
    }

    #[test]
    fn room_in_logical_px_follows_the_scale() {
        let span = Span {
            side: Side::Left,
            left: 100,
            right: 400,
        };
        assert_eq!(room_logical(Some(span), 1.0), 300);
        assert_eq!(room_logical(Some(span), 1.5), 200);
        assert_eq!(room_logical(None, 1.5), 0);
    }
}
