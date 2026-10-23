//! Keeps the compact taskbar strip (and its per-display copies) docked at the
//! far left of each taskbar. When the gap left of the centred app buttons is
//! narrower than the strip, the strip shrinks to fit instead of leaving the
//! taskbar, and grows back as the gap widens.
use super::*;

pub(super) const MAX_DISPLAYS: usize = 8;
/// Smallest size the strip is shrunk to before it is allowed to leave the taskbar.
pub(super) const MIN_FIT_PERCENT: u32 = 50;
/// Distance kept between the strip's right edge and the first app button (at least
/// the clearance the re-dock check asks for, so a docked strip never needs more
/// room to come back than it has).
pub(super) const CLEARANCE: i32 = 32;
/// Fallback gap between the strip and the taskbar's left edge, in logical px
/// (the clock's gap to the taskbar's right edge is used when it can be read).
const FALLBACK_EDGE: i32 = 12;
const UNSET: i32 = i32::MIN;

static FIT: [AtomicU32; MAX_DISPLAYS] = [const { AtomicU32::new(100) }; MAX_DISPLAYS];
static EDGE: [std::sync::atomic::AtomicI32; MAX_DISPLAYS] =
    [const { std::sync::atomic::AtomicI32::new(UNSET) }; MAX_DISPLAYS];
static OFFSET: [std::sync::atomic::AtomicI32; MAX_DISPLAYS] =
    [const { std::sync::atomic::AtomicI32::new(UNSET) }; MAX_DISPLAYS];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Fit {
    pub percent: u32,
    /// Physical distance from the taskbar's left edge; `None` keeps the saved one.
    pub offset: Option<i32>,
    /// Physical gap kept between the strip and the taskbar's left edge.
    pub left_edge: i32,
}

/// The measured left gap of `display`'s strip, or 12 logical px at `scale`
/// until it has been measured.
pub(super) fn left_edge(display: usize, scale: f64) -> i32 {
    match EDGE.get(display).map(|e| e.load(Ordering::Relaxed)) {
        Some(edge) if edge != UNSET => edge,
        _ => fallback_edge(scale),
    }
}

pub(super) fn fallback_edge(scale: f64) -> i32 {
    (FALLBACK_EDGE as f64 * scale).round() as i32
}

pub(super) fn current(display: usize) -> Fit {
    let Some(fit) = FIT.get(display) else {
        return Fit {
            percent: 100,
            offset: None,
            left_edge: fallback_edge(1.0),
        };
    };
    let offset = OFFSET[display].load(Ordering::Relaxed);
    Fit {
        percent: fit.load(Ordering::Relaxed),
        offset: (offset != UNSET).then_some(offset),
        left_edge: left_edge(display, 1.0),
    }
}

pub(super) fn percent(display: usize) -> u32 {
    current(display).percent
}

pub(super) fn store(display: usize, fit: Fit) {
    if display < MAX_DISPLAYS {
        FIT[display].store(fit.percent, Ordering::Relaxed);
        OFFSET[display].store(fit.offset.unwrap_or(UNSET), Ordering::Relaxed);
        EDGE[display].store(fit.left_edge, Ordering::Relaxed);
    }
}

/// Pure planner. `slot_right` is the free gap's right edge measured from the
/// taskbar's left edge, `width` the strip's width at 100 %, `saved` its saved
/// offset (`None` for a copy that has none). `None` means it cannot fit.
pub(super) fn plan(
    slot_right: i32,
    width: i32,
    saved: Option<i32>,
    left_edge: i32,
) -> Option<Fit> {
    let room = slot_right - CLEARANCE;
    let width = width.max(1);
    if left_edge + width <= room {
        let farthest = room - width;
        return Some(Fit {
            percent: 100,
            offset: match saved {
                Some(saved) if saved >= left_edge && saved <= farthest => None,
                Some(saved) if saved < left_edge => Some(left_edge),
                Some(_) => Some(farthest.max(left_edge)),
                None => None,
            },
            left_edge,
        });
    }
    // One pixel of rounding safety.
    let percent = ((room - left_edge - 1) as f64 * 100.0 / width as f64).floor();
    (percent >= MIN_FIT_PERCENT as f64).then_some(Fit {
        percent: percent as u32,
        offset: Some(left_edge),
        left_edge,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_strip_that_fits_keeps_its_saved_place() {
        assert_eq!(
            plan(1200, 999, Some(50), 4),
            Some(Fit {
                percent: 100,
                offset: None,
                left_edge: 4
            })
        );
    }

    #[test]
    fn a_strip_that_fits_only_further_left_moves_left_at_full_size() {
        assert_eq!(
            plan(1050, 999, Some(50), 4),
            Some(Fit {
                percent: 100,
                offset: Some(19),
                left_edge: 4
            })
        );
    }

    #[test]
    fn the_reported_950_pixel_gap_shrinks_the_999_pixel_strip_instead_of_ejecting() {
        let fit = plan(950, 999, Some(50), 4).unwrap();
        assert_eq!(fit.offset, Some(4));
        assert!((90..100).contains(&fit.percent), "{}", fit.percent);
        assert!(4 + 999 * fit.percent as i32 / 100 <= 950 - CLEARANCE);
    }

    #[test]
    fn the_strip_keeps_the_measured_left_gap_and_the_fit_counts_it() {
        assert_eq!(plan(1200, 999, Some(2), 30).unwrap().offset, Some(30));
        let fit = plan(950, 999, None, 30).unwrap();
        assert_eq!(fit.offset, Some(30));
        assert!(30 + 999 * fit.percent as i32 / 100 <= 950 - CLEARANCE);
        assert_eq!(fallback_edge(1.5), 18);
    }

    #[test]
    fn a_gap_too_small_even_for_the_minimum_size_ejects() {
        assert_eq!(plan(400, 999, None, 4), None);
        assert!(plan(560, 999, None, 4).is_some());
    }
}
