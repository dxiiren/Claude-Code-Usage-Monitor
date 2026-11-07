//! Optional "Agent Hub" sources (a coding-agent hub's Qoder quota, self-hosted
//! model endpoints). Nothing runs unless settings.json has `agent_hub_command`:
//! a command that prints one JSON document,
//! `{"version":1,"sources":[{"id","name","text","percent"?,"up"?}]}`.
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
        match (self.percent, self.up) {
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
}
