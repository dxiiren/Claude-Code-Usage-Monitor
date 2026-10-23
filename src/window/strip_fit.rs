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
/// Distance kept between the strip and the taskbar's left edge.
const LEFT_EDGE: i32 = 4;
const UNSET: i32 = i32::MIN;

static FIT: [AtomicU32; MAX_DISPLAYS] = [const { AtomicU32::new(100) }; MAX_DISPLAYS];
static OFFSET: [std::sync::atomic::AtomicI32; MAX_DISPLAYS] =
    [const { std::sync::atomic::AtomicI32::new(UNSET) }; MAX_DISPLAYS];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Fit {
    pub percent: u32,
    /// Physical distance from the taskbar's left edge; `None` keeps the saved one.
    pub offset: Option<i32>,
}

pub(super) fn current(display: usize) -> Fit {
    let Some(fit) = FIT.get(display) else {
        return Fit {
            percent: 100,
            offset: None,
        };
    };
    let offset = OFFSET[display].load(Ordering::Relaxed);
    Fit {
        percent: fit.load(Ordering::Relaxed),
        offset: (offset != UNSET).then_some(offset),
    }
}

pub(super) fn percent(display: usize) -> u32 {
    current(display).percent
}

pub(super) fn store(display: usize, fit: Fit) {
    if display < MAX_DISPLAYS {
        FIT[display].store(fit.percent, Ordering::Relaxed);
        OFFSET[display].store(fit.offset.unwrap_or(UNSET), Ordering::Relaxed);
    }
}

/// Pure planner. `slot_right` is the free gap's right edge measured from the
/// taskbar's left edge, `width` the strip's width at 100 %, `saved` its saved
/// offset (`None` for a copy that has none). `None` means it cannot fit.
pub(super) fn plan(slot_right: i32, width: i32, saved: Option<i32>) -> Option<Fit> {
    let room = slot_right - CLEARANCE;
    let width = width.max(1);
    if LEFT_EDGE + width <= room {
        let farthest = room - width;
        return Some(Fit {
            percent: 100,
            offset: match saved {
                Some(saved) if saved >= LEFT_EDGE && saved <= farthest => None,
                Some(_) => Some(farthest.max(LEFT_EDGE)),
                None => None,
            },
        });
    }
    // One pixel of rounding safety.
    let percent = ((room - LEFT_EDGE - 1) as f64 * 100.0 / width as f64).floor();
    (percent >= MIN_FIT_PERCENT as f64).then_some(Fit {
        percent: percent as u32,
        offset: Some(LEFT_EDGE),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_strip_that_fits_keeps_its_saved_place() {
        assert_eq!(
            plan(1200, 999, Some(50)),
            Some(Fit {
                percent: 100,
                offset: None
            })
        );
    }

    #[test]
    fn a_strip_that_fits_only_further_left_moves_left_at_full_size() {
        assert_eq!(
            plan(1050, 999, Some(50)),
            Some(Fit {
                percent: 100,
                offset: Some(19)
            })
        );
    }

    #[test]
    fn the_reported_950_pixel_gap_shrinks_the_999_pixel_strip_instead_of_ejecting() {
        let fit = plan(950, 999, Some(50)).unwrap();
        assert_eq!(fit.offset, Some(4));
        assert!((90..100).contains(&fit.percent), "{}", fit.percent);
        assert!(4 + 999 * fit.percent as i32 / 100 <= 950 - CLEARANCE);
    }

    #[test]
    fn a_gap_too_small_even_for_the_minimum_size_ejects() {
        assert_eq!(plan(400, 999, None), None);
        assert!(plan(560, 999, None).is_some());
    }
}
