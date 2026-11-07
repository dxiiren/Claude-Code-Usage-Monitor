//! Which accounts and which usage rows (5-hour, 7-day) the widget shows.
//! Persisted in settings.json under `widget`; an old file without the key
//! shows everything, exactly as before.
use std::collections::BTreeSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::theme_engine::SurfaceNest;

/// What one view (the taskbar strip or the floating card) shows: which
/// entries are unticked and whether the 5-hour and 7-day rows are on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct View {
    /// Keys such as `claude.work`, `codex.main` or `hub.qoder` whose tick differs
    /// from the default: accounts are on by default, so these are the unticked
    /// ones; Agent Hub providers are off by default on the taskbar strip (it has
    /// little room) and on everywhere else, so on the strip these are the ticked ones.
    pub hidden: BTreeSet<String>,
    pub show_5h: bool,
    pub show_7d: bool,
}

impl Default for View {
    fn default() -> Self {
        Self {
            hidden: BTreeSet::new(),
            show_5h: true,
            show_7d: true,
        }
    }
}

impl View {
    fn is_shown(&self, default_on: bool, key: &str) -> bool {
        default_on != self.hidden.contains(key)
    }
}

/// Is `key` ticked by default in this view? Only Agent Hub providers on the
/// taskbar strip start unticked.
fn default_on(nest: SurfaceNest, key: &str) -> bool {
    !(nest == SurfaceNest::Taskbar && key.starts_with("hub."))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Row {
    FiveHour,
    SevenDay,
}

/// The strip and the card are chosen separately: the taskbar has room for a
/// few tiles, the card for all of them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WidgetFilter {
    pub taskbar: View,
    pub card: View,
}

impl WidgetFilter {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    pub fn view(&self, nest: SurfaceNest) -> &View {
        if nest == SurfaceNest::Taskbar {
            &self.taskbar
        } else {
            &self.card
        }
    }

    fn view_mut(&mut self, nest: SurfaceNest) -> &mut View {
        if nest == SurfaceNest::Taskbar {
            &mut self.taskbar
        } else {
            &mut self.card
        }
    }

    pub fn is_shown(&self, nest: SurfaceNest, key: &str) -> bool {
        self.view(nest).is_shown(default_on(nest, key), key)
    }

    pub fn toggle_account(&mut self, nest: SurfaceNest, key: &str) {
        let view = self.view_mut(nest);
        if !view.hidden.remove(key) {
            view.hidden.insert(key.to_string());
        }
    }

    pub fn toggle_row(&mut self, nest: SurfaceNest, row: Row) {
        let view = self.view_mut(nest);
        match row {
            Row::FiveHour => view.show_5h = !view.show_5h,
            Row::SevenDay => view.show_7d = !view.show_7d,
        }
    }
}

/// A menu action names the view it edits with a prefix: `taskbar:` or `card:`
/// (`taskbar:claude.work`, `card:hub.*`, `taskbar:5h`). Without a prefix it
/// edits the view that was right-clicked.
pub fn split_target(spec: &str) -> (Option<SurfaceNest>, &str) {
    if let Some(rest) = spec.strip_prefix("taskbar:") {
        (Some(SurfaceNest::Taskbar), rest)
    } else if let Some(rest) = spec.strip_prefix("card:") {
        (Some(SurfaceNest::Floating), rest)
    } else {
        (None, spec)
    }
}

/// Logical width the taskbar strip can hold before the shell would move it
/// off the taskbar (the owner's strip holds six 112 px account tiles).
pub const TASKBAR_BUDGET: u32 = 672;
/// Width of one account tile in the compact taskbar theme.
pub const ACCOUNT_TILE_W: u32 = 112;
pub const HUB_FULL_W: u32 = 156;
pub const HUB_COMPACT_W: u32 = 78;
/// The "+N" tile that stands for the providers that did not fit.
pub const HUB_OVERFLOW_W: u32 = 40;
/// Most tiles on one card row; more start a further row (the rows are then balanced).
pub const CARD_PER_ROW: u32 = 6;

/// How the ticked Agent Hub providers are laid out in one view. Themes read it
/// as `hub.layout.*`, `hub.slotN.x/row` and `hub.overflow.*`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HubLayout {
    pub tile_w: u32,
    /// One value line instead of two: the strip ran out of room.
    pub compact: bool,
    /// Providers drawn (the first ones).
    pub fit: u32,
    /// Providers folded into the "+N" tile.
    pub overflow: u32,
    pub rows: u32,
    pub per_row: u32,
    /// Width of the widest hub row in px, including the "+N" tile.
    pub width: u32,
}

/// `accounts_w` is the px the account tiles already take on the strip.
/// The card wraps at six per row; the strip is one row and falls back to
/// compact tiles, then to a "+N" tile, so nothing is ever clipped.
pub fn hub_layout(nest: SurfaceNest, hub_shown: u32, accounts_w: u32) -> HubLayout {
    if hub_shown == 0 {
        return HubLayout::default();
    }
    if nest != SurfaceNest::Taskbar {
        // Balanced rows (7 -> 4 + 3, never 6 + 1): as few rows as the width needs, then equal ones.
        let rows = hub_shown.div_ceil(CARD_PER_ROW);
        let per_row = hub_shown.div_ceil(rows);
        return HubLayout {
            tile_w: HUB_FULL_W,
            compact: false,
            fit: hub_shown,
            overflow: 0,
            rows,
            per_row,
            width: per_row * HUB_FULL_W,
        };
    }
    let room = TASKBAR_BUDGET.saturating_sub(accounts_w);
    let layout = |tile_w, compact, fit: u32, overflow: u32| HubLayout {
        tile_w,
        compact,
        fit,
        overflow,
        rows: 1,
        per_row: hub_shown,
        width: fit * tile_w + if overflow > 0 { HUB_OVERFLOW_W } else { 0 },
    };
    if hub_shown * HUB_FULL_W <= room {
        layout(HUB_FULL_W, false, hub_shown, 0)
    } else if hub_shown * HUB_COMPACT_W <= room {
        layout(HUB_COMPACT_W, true, hub_shown, 0)
    } else {
        let fit = (room.saturating_sub(HUB_OVERFLOW_W) / HUB_COMPACT_W).min(hub_shown - 1);
        layout(HUB_COMPACT_W, true, fit, hub_shown - fit)
    }
}

static CURRENT: Mutex<Option<WidgetFilter>> = Mutex::new(None);

pub fn current() -> WidgetFilter {
    CURRENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_default()
}

pub fn set(filter: WidgetFilter) {
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(filter);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_key_shows_everything() {
        let filter: WidgetFilter = serde_json::from_str("{}").unwrap();
        assert!(filter.is_default());
        assert!(filter.is_shown(SurfaceNest::Taskbar, "claude.work"));
        assert!(filter.taskbar.show_5h && filter.taskbar.show_7d);
        assert!(filter.card.show_5h && filter.card.show_7d);
        let partial: WidgetFilter = serde_json::from_str(r#"{"card":{"show_7d":false}}"#).unwrap();
        assert!(partial.card.show_5h && !partial.card.show_7d);
        assert!(partial.taskbar.show_7d && partial.taskbar.hidden.is_empty());
    }

    #[test]
    fn menu_targets_name_the_view_with_a_prefix() {
        assert_eq!(
            split_target("taskbar:5h"),
            (Some(SurfaceNest::Taskbar), "5h")
        );
        assert_eq!(
            split_target("card:hub.*"),
            (Some(SurfaceNest::Floating), "hub.*")
        );
        assert_eq!(split_target("claude.work"), (None, "claude.work"));
    }

    #[test]
    fn hub_providers_start_off_on_the_strip_and_on_on_the_card() {
        let mut filter = WidgetFilter::default();
        assert!(!filter.is_shown(SurfaceNest::Taskbar, "hub.qoder"));
        assert!(filter.is_shown(SurfaceNest::Floating, "hub.qoder"));
        assert!(filter.is_shown(SurfaceNest::Taskbar, "claude.work"));
        filter.toggle_account(SurfaceNest::Taskbar, "hub.qoder");
        filter.toggle_account(SurfaceNest::Floating, "hub.codex");
        assert!(
            filter.is_shown(SurfaceNest::Taskbar, "hub.qoder"),
            "ticked on the strip"
        );
        assert!(
            !filter.is_shown(SurfaceNest::Floating, "hub.codex"),
            "unticked on the card"
        );
        assert!(
            filter.is_shown(SurfaceNest::Floating, "hub.qoder"),
            "views are separate"
        );
        let json = serde_json::to_string(&filter).unwrap();
        assert_eq!(serde_json::from_str::<WidgetFilter>(&json).unwrap(), filter);
        filter.toggle_account(SurfaceNest::Taskbar, "hub.qoder");
        filter.toggle_account(SurfaceNest::Floating, "hub.codex");
        assert!(filter.is_default());
    }

    #[test]
    fn card_layout_wraps_at_six_per_row_and_keeps_full_tiles() {
        assert_eq!(
            hub_layout(SurfaceNest::Floating, 0, 0),
            HubLayout::default()
        );
        let one = hub_layout(SurfaceNest::Floating, 4, 0);
        assert_eq!(
            (one.rows, one.fit, one.overflow, one.compact, one.width),
            (1, 4, 0, false, 4 * 156)
        );
        let six = hub_layout(SurfaceNest::Floating, 6, 0);
        assert_eq!((six.rows, six.per_row), (1, 6));
        let two = hub_layout(SurfaceNest::Floating, 7, 0);
        assert_eq!(
            (two.rows, two.per_row, two.fit, two.width),
            (2, 4, 7, 4 * 156)
        );
    }

    #[test]
    fn card_rows_are_balanced_and_never_leave_a_lone_tile() {
        for n in 2..=12u32 {
            let l = hub_layout(SurfaceNest::Floating, n, 0);
            assert!(l.per_row <= CARD_PER_ROW, "{n}");
            assert_eq!(l.rows, n.div_ceil(l.per_row), "{n}");
            let last = n - (l.rows - 1) * l.per_row;
            assert!(last >= 2, "{n} tiles leave {last} alone on the last row");
        }
    }

    #[test]
    fn strip_layout_falls_back_full_then_compact_then_plus_n_and_never_exceeds_the_budget() {
        // Room for 3 full tiles after 3 accounts (672 - 336 = 336 -> 2 full fit, 4 compact fit).
        let full = hub_layout(SurfaceNest::Taskbar, 2, 336);
        assert_eq!(
            (full.tile_w, full.compact, full.fit, full.overflow),
            (156, false, 2, 0)
        );
        let compact = hub_layout(SurfaceNest::Taskbar, 4, 336);
        assert_eq!(
            (
                compact.tile_w,
                compact.compact,
                compact.fit,
                compact.overflow
            ),
            (78, true, 4, 0)
        );
        let plus = hub_layout(SurfaceNest::Taskbar, 7, 336);
        assert_eq!((plus.fit, plus.overflow, plus.compact), (3, 4, true));
        for accounts in 0..=7u32 {
            for hub in 0..=12u32 {
                let l = hub_layout(SurfaceNest::Taskbar, hub, accounts * ACCOUNT_TILE_W);
                assert_eq!(
                    l.fit + l.overflow,
                    hub,
                    "every provider is drawn or counted"
                );
                let room = TASKBAR_BUDGET.saturating_sub(accounts * ACCOUNT_TILE_W);
                if l.fit > 0 {
                    assert!(
                        l.width <= room,
                        "{accounts} accounts, {hub} hub: {} > {room}",
                        l.width
                    );
                }
            }
        }
        // Accounts alone fill the strip: only the "+N" tile is left, never a clipped tile.
        let none_fit = hub_layout(SurfaceNest::Taskbar, 3, 672);
        assert_eq!((none_fit.fit, none_fit.overflow), (0, 3));
    }

    #[test]
    fn toggles_are_per_account_and_per_view_and_round_trip() {
        let mut filter = WidgetFilter::default();
        filter.toggle_account(SurfaceNest::Taskbar, "claude.work");
        assert!(!filter.is_shown(SurfaceNest::Taskbar, "claude.work"));
        assert!(filter.is_shown(SurfaceNest::Taskbar, "claude.home"));
        assert!(
            filter.is_shown(SurfaceNest::Floating, "claude.work"),
            "the card keeps its own list"
        );
        filter.toggle_row(SurfaceNest::Taskbar, Row::FiveHour);
        assert!(!filter.view(SurfaceNest::Taskbar).show_5h);
        assert!(filter.view(SurfaceNest::Floating).show_5h);
        let json = serde_json::to_string(&filter).unwrap();
        assert_eq!(serde_json::from_str::<WidgetFilter>(&json).unwrap(), filter);
        filter.toggle_account(SurfaceNest::Taskbar, "claude.work");
        filter.toggle_row(SurfaceNest::Taskbar, Row::FiveHour);
        assert!(filter.is_default());
    }
}
