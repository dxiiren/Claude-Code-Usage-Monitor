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
    /// Keys such as `claude.work`, `codex.main` or `hub.qoder` that are unticked.
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
    pub fn is_shown(&self, key: &str) -> bool {
        !self.hidden.contains(key)
    }
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
        self.view(nest).is_shown(key)
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
