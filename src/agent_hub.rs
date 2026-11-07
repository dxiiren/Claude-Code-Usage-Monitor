//! Optional "Agent Hub" sources (a coding-agent hub's Qoder quota, self-hosted
//! model endpoints). Nothing runs unless settings.json has `agent_hub_command`:
//! a command that prints one JSON document,
//! `{"version":1,"sources":[{"id","name","kind"?,"text","percent"?,"up"?,"idle"?,
//! "tokens_today"?,"tokens_7d"?}]}`.
//! The widget runs it at most every five minutes, off the UI thread, and the
//! entries appear as `hub.<id>.*` theme variables and as menu checkboxes.
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

pub const REFRESH_SECONDS: u64 = 300;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_OUTPUT: u64 = 64 * 1024;
/// Also the number of `hub.slotN` variables a theme can draw.
pub const MAX_SOURCES: usize = 12;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HubSource {
    /// Theme-safe key: lowercase letters, digits and `_`.
    pub id: String,
    pub name: String,
    pub text: String,
    pub percent: Option<f64>,
    pub up: Option<bool>,
    /// Not running now but the hub starts it on demand: neither up nor down.
    pub idle: bool,
    /// What the provider is (`qwen`, `qoder`, `codex`...). The taskbar strip has
    /// room for one tile per kind, so providers of one kind share a tile there.
    pub kind: String,
    pub tokens_today: Option<u64>,
    pub tokens_7d: Option<u64>,
}

#[derive(Deserialize)]
struct Document {
    #[serde(default)]
    sources: Vec<Raw>,
}

#[derive(Deserialize)]
struct Raw {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    text: String,
    percent: Option<f64>,
    up: Option<bool>,
    idle: Option<bool>,
    #[serde(default)]
    kind: String,
    tokens_today: Option<u64>,
    tokens_7d: Option<u64>,
}

fn theme_safe(id: &str) -> String {
    id.to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

impl HubSource {
    /// The one-line value for a compact tile: the percentage, else up/down,
    /// else the first word of the text (`818k` of `818k today`).
    pub fn short(&self) -> String {
        let status = if self.idle {
            Some("idle")
        } else {
            self.up.map(|up| if up { "up" } else { "down" })
        };
        // A provider with a status and a token count shows both ("up 562.2k").
        if let (Some(status), Some(today), None) = (status, self.tokens_today, self.percent) {
            return format!("{status} {}", fmt_tokens(today));
        }
        match (self.percent, self.up) {
            _ if self.idle => "idle".into(),
            (Some(percent), _) => format!("{percent:.0}%"),
            (None, Some(up)) => if up { "up" } else { "down" }.into(),
            _ => self
                .text
                .split_whitespace()
                .next()
                .unwrap_or("")
                .chars()
                .take(10)
                .collect(),
        }
    }
}

fn fmt_tokens(n: u64) -> String {
    match n {
        1_000_000.. => format!("{:.1}M", n as f64 / 1e6),
        1_000.. => format!("{:.1}k", n as f64 / 1e3),
        _ => n.to_string(),
    }
}

/// The taskbar strip's view of the providers: one entry per `kind` (a source
/// with no kind is its own kind), in first-seen order. A kind with one member is
/// that member under the kind's id. A kind with several becomes one tile named
/// after the kind: up when any member is up, idle when none is up but one can
/// start, else down; the summed tokens of today and of 7 days. A future provider
/// of the same kind joins it with no widget change.
pub fn group_by_kind(sources: &[HubSource]) -> Vec<HubSource> {
    let key = |source: &HubSource| {
        if source.kind.is_empty() {
            source.id.clone()
        } else {
            source.kind.clone()
        }
    };
    let mut order: Vec<String> = Vec::new();
    for source in sources {
        if !order.contains(&key(source)) {
            order.push(key(source));
        }
    }
    order
        .into_iter()
        .map(|group| {
            let members: Vec<&HubSource> = sources.iter().filter(|s| key(s) == group).collect();
            let mut tile = members[0].clone();
            tile.id = group.clone();
            if members.len() == 1 {
                return tile;
            }
            let sum = |value: fn(&HubSource) -> Option<u64>| {
                members
                    .iter()
                    .filter_map(|member| value(member))
                    .reduce(|a, b| a + b)
            };
            tile.tokens_today = sum(|s| s.tokens_today);
            tile.tokens_7d = sum(|s| s.tokens_7d);
            let any_up = members.iter().any(|m| m.up == Some(true));
            tile.up = if any_up {
                Some(true)
            } else if members.iter().any(|m| m.up.is_some()) {
                Some(false)
            } else {
                None
            };
            tile.idle = !any_up && members.iter().any(|m| m.idle);
            tile.percent = None;
            let mut name = group.clone();
            name[..1].make_ascii_uppercase();
            tile.name = name;
            let status = match (tile.idle, tile.up) {
                (true, _) => Some("idle"),
                (_, Some(true)) => Some("up"),
                (_, Some(false)) => Some("down"),
                _ => None,
            };
            let today = tile
                .tokens_today
                .map(|n| format!("{} today", fmt_tokens(n)));
            let week = tile
                .tokens_7d
                .map(|n| format!("{} in 7 days", fmt_tokens(n)));
            let first = [status.map(String::from), today]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" - ");
            tile.text = [first, week.unwrap_or_default()]
                .into_iter()
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            tile
        })
        .collect()
}

/// Ids the widget keeps for its own variables (`hub.layout.*`, `hub.overflow.*`, `hub.slotN.*`).
fn reserved(id: &str) -> bool {
    matches!(id, "layout" | "overflow")
        || id
            .strip_prefix("slot")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Parse the command's output. Bad entries are dropped, never fatal.
pub fn parse(json: &str) -> Result<Vec<HubSource>, String> {
    let document: Document = serde_json::from_str(json.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("agent hub output is not the expected JSON: {error}"))?;
    let mut sources: Vec<HubSource> = Vec::new();
    for raw in document.sources.into_iter().take(MAX_SOURCES) {
        let mut id = theme_safe(&raw.id);
        if reserved(&id) {
            id.push_str("_p");
        }
        if id.is_empty() || sources.iter().any(|source| source.id == id) {
            continue;
        }
        sources.push(HubSource {
            name: if raw.name.trim().is_empty() {
                id.clone()
            } else {
                raw.name.chars().take(40).collect()
            },
            text: raw.text.chars().take(120).collect(),
            percent: raw
                .percent
                .filter(|p| p.is_finite())
                .map(|p| p.clamp(0.0, 100.0)),
            up: raw.up,
            idle: raw.idle == Some(true),
            kind: theme_safe(&raw.kind),
            tokens_today: raw.tokens_today,
            tokens_7d: raw.tokens_7d,
            id,
        });
    }
    Ok(sources)
}

/// Run the configured command (hidden window, 25 s limit) and parse it.
pub fn run_command(command: &str) -> Result<Vec<HubSource>, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // cmd strips the outer quotes, so a command with its own quoted paths runs as typed.
    let mut child = Command::new("cmd")
        .raw_arg(format!("/C \"{command}\""))
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("agent hub command did not start: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("no output pipe")?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = (&mut stdout).take(MAX_OUTPUT).read_to_string(&mut text);
        text
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > COMMAND_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("agent hub command timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(error.to_string()),
        }
    }
    parse(&reader.join().unwrap_or_default())
}

struct State {
    command: String,
    sources: Vec<HubSource>,
    last_run: Option<Instant>,
    running: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    command: String::new(),
    sources: Vec::new(),
    last_run: None,
    running: false,
});

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn current() -> Vec<HubSource> {
    state().sources.clone()
}

/// Called whenever settings load. A changed command refreshes at once; an
/// emptied one clears the entries.
pub fn configure(command: &str) {
    let mut state = state();
    if state.command != command.trim() {
        state.command = command.trim().to_string();
        state.last_run = None;
        if state.command.is_empty() {
            state.sources.clear();
        }
    }
}

/// Start a refresh if one is due and none is running. `done(changed)` is
/// called from the worker thread when the entries changed.
pub fn refresh_if_due(done: impl FnOnce(bool) + Send + 'static) {
    let command = {
        let mut state = state();
        let due = state
            .last_run
            .is_none_or(|at| at.elapsed() >= Duration::from_secs(REFRESH_SECONDS));
        if state.command.is_empty() || state.running || !due {
            return;
        }
        state.running = true;
        state.last_run = Some(Instant::now());
        state.command.clone()
    };
    std::thread::spawn(move || {
        let result = run_command(&command);
        let mut state = state();
        state.running = false;
        let changed = match result {
            Ok(sources) if sources != state.sources => {
                state.sources = sources;
                true
            }
            // A failed run keeps the last entries; they are at most one cycle stale.
            _ => false,
        };
        drop(state);
        if changed {
            done(true);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_qoder_and_endpoints_and_cleans_ids() {
        let json = r#"{"version":1,"sources":[
            {"id":"qoder","name":"Qoder","text":"49.2% | 6.3k used","percent":49.2},
            {"id":"Qwen .122","name":"Qwen .122","text":"up | 1k today","up":true},
            {"id":"qoder","name":"dup"},
            {"id":"","name":"no id"},
            {"id":"over","percent":900}]}"#;
        let sources = parse(json).unwrap();
        assert_eq!(
            sources.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["qoder", "qwen__122", "over"]
        );
        assert_eq!(sources[0].percent, Some(49.2));
        assert_eq!(sources[1].up, Some(true));
        assert_eq!(sources[1].percent, None, "no invented percentage");
        assert_eq!(sources[2].percent, Some(100.0));
        assert_eq!(sources[2].name, "over");
    }

    #[test]
    fn short_value_and_reserved_ids() {
        let s = |percent, up, text: &str| HubSource {
            percent,
            up,
            text: text.into(),
            ..Default::default()
        };
        assert_eq!(s(Some(49.2), None, "x").short(), "49%");
        assert_eq!(s(None, Some(false), "x").short(), "down");
        assert_eq!(s(None, None, "818.5k today\nmore").short(), "818.5k");
        let parsed =
            parse(r#"{"sources":[{"id":"slot3"},{"id":"layout"},{"id":"slot"}]}"#).unwrap();
        assert_eq!(
            parsed.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["slot3_p", "layout_p", "slot"]
        );
    }

    #[test]
    fn bad_json_is_an_error_and_an_empty_list_is_fine() {
        assert!(parse("not json").is_err());
        assert!(parse("{\"sources\":[]}").unwrap().is_empty());
        assert!(parse("\u{feff}{\"sources\":[]}").is_ok());
    }

    #[test]
    fn runs_a_command_and_reads_its_json() {
        let sources =
            run_command(r#"echo {"sources":[{"id":"a","name":"A","text":"x","up":false}]}"#)
                .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].up, Some(false));
        assert!(run_command("exit 3").is_err());
    }

    fn src(id: &str, kind: &str, up: Option<bool>, idle: bool, today: u64, week: u64) -> HubSource {
        HubSource {
            id: id.into(),
            name: id.into(),
            kind: kind.into(),
            up,
            idle,
            tokens_today: Some(today),
            tokens_7d: Some(week),
            text: "x".into(),
            ..Default::default()
        }
    }

    #[test]
    fn qwen_providers_share_one_taskbar_tile() {
        let sources = [
            src("qwen_laptop", "qwen", None, true, 155_200, 277_800),
            src("qoder", "qoder", None, false, 0, 0),
            src("qwen_122", "qwen", Some(true), false, 141_700, 312_200),
            src("qwen_110", "qwen", Some(true), false, 265_300, 602_200),
        ];
        let grouped = group_by_kind(&sources);
        assert_eq!(
            grouped.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["qwen", "qoder"],
            "one tile per kind, first-seen order"
        );
        let qwen = &grouped[0];
        assert_eq!(qwen.name, "Qwen");
        assert_eq!(qwen.up, Some(true), "up when any member is up");
        assert!(!qwen.idle);
        assert_eq!(qwen.tokens_today, Some(562_200));
        assert_eq!(qwen.tokens_7d, Some(1_192_200));
        assert_eq!(qwen.text, "up - 562.2k today\n1.2M in 7 days");
        assert_eq!(qwen.short(), "up 562.2k", "compact tile: status and tokens today");
        assert_eq!(grouped[1].name, "qoder", "a lone provider is unchanged");
    }

    #[test]
    fn group_status_idle_down_and_future_members() {
        let idle = group_by_kind(&[
            src("a", "qwen", None, true, 1, 2),
            src("b", "qwen", Some(false), false, 1, 2),
        ]);
        assert!(idle[0].idle, "none up but one can start: idle");
        assert_eq!(idle[0].short(), "idle 2");
        let down = group_by_kind(&[
            src("a", "qwen", Some(false), false, 0, 0),
            src("b", "qwen", Some(false), false, 0, 0),
        ]);
        assert_eq!(down[0].up, Some(false));
        assert_eq!(down[0].text, "down - 0 today\n0 in 7 days");
        // a provider the hub adds later with the same kind joins the tile
        let more = group_by_kind(&[
            src("a", "qwen", Some(true), false, 1000, 1000),
            src("b", "qwen", Some(true), false, 1000, 1000),
            src("qwen_new", "qwen", Some(true), false, 1000, 1000),
        ]);
        assert_eq!(more.len(), 1);
        assert_eq!(more[0].tokens_today, Some(3000));
        // no kind: the id is the kind, nothing merges by accident
        let none = group_by_kind(&[
            HubSource {
                id: "x".into(),
                ..Default::default()
            },
            HubSource {
                id: "y".into(),
                ..Default::default()
            },
        ]);
        assert_eq!(none.len(), 2);
    }

    #[test]
    fn kind_and_tokens_are_read_from_the_json() {
        let parsed = parse(
            r#"{"sources":[{"id":"q","kind":"Qwen","tokens_today":5,"tokens_7d":9},{"id":"z"}]}"#,
        )
        .unwrap();
        assert_eq!(parsed[0].kind, "qwen");
        assert_eq!(
            (parsed[0].tokens_today, parsed[0].tokens_7d),
            (Some(5), Some(9))
        );
        assert_eq!(parsed[1].kind, "");
    }
}
