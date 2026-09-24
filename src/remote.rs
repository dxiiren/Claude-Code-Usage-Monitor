//! Remote mode: Claude accounts and usage read from an Account Manager server.
//!
//! When `settings.json` carries both `remote_server_url` and
//! `remote_server_token`, the Claude provider stops reading local credential
//! files. Its accounts, usage and login state come from the server's
//! `GET /api/v1/widget` (see `docs/account-manager-contract.md`, "Server mode").
//! Precedence: remote mode > `accounts.db` > `settings.json` profiles.
//! The token is a bearer secret: it is only sent to https URLs (or plain http
//! on loopback / private LAN addresses) and is never logged.
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize};

use crate::accounts::{fingerprint, AccountProfile, AccountSettings, ProviderAccounts};
use crate::app_settings::SettingsFile;
use crate::models::{AccountUsage, UsageData, UsageSection};
use crate::poller::PollError;
use crate::providers::ProviderId;

/// How often the widget asks the server whether its payload changed.
pub const CHECK_INTERVAL_MS: u32 = 30_000;
const WIDGET_PATH: &str = "/api/v1/widget";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A poll right after a revision check reuses that payload instead of asking again.
const REUSE_WINDOW: Duration = Duration::from_secs(10);
const MAX_BODY_BYTES: u64 = 1024 * 1024;
const SNAPSHOT_FILE: &str = "remote-accounts.json";
const SIGNATURE_PREFIX: &str = "remote:";

/// A bearer secret. Serialized as a plain string; `Debug` never prints it.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SecretToken(String);

impl SecretToken {
    #[cfg(test)]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn is_empty(&self) -> bool {
        self.0.trim().is_empty()
    }

    fn expose(&self) -> &str {
        self.0.trim()
    }
}

impl std::fmt::Debug for SecretToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.is_empty() {
            "SecretToken(<empty>)"
        } else {
            "SecretToken(<redacted>)"
        })
    }
}

/// Remote mode is on when both settings are non-empty.
#[derive(Clone, PartialEq, Eq)]
pub struct RemoteConfig {
    url: String,
    token: SecretToken,
}

impl std::fmt::Debug for RemoteConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteConfig")
            .field("url", &self.url)
            .field("token", &self.token)
            .finish()
    }
}

impl RemoteConfig {
    pub fn from_settings(settings: &SettingsFile) -> Option<Self> {
        let url = settings.remote_server_url.trim();
        (!url.is_empty() && !settings.remote_server_token.is_empty()).then(|| Self {
            url: url.to_string(),
            token: settings.remote_server_token.clone(),
        })
    }

    /// Identifies url + token without holding the token itself.
    fn key(&self) -> String {
        fingerprint(&format!(
            "{}\n{}",
            self.url,
            fingerprint(self.token.expose())
        ))
    }

    /// The widget endpoint, or why this URL must not receive the token.
    pub fn endpoint(&self) -> Result<String, String> {
        validate_url(&self.url)?;
        Ok(endpoint_for(&self.url))
    }
}

/// Only https, or plain http to loopback / a private LAN address: the token
/// is a bearer secret and must not cross the internet in clear text.
pub fn validate_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    let (secure, rest) = if let Some(rest) = lower.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = lower.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err("remote_server_url must start with https://".into());
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return Err("remote_server_url must not contain a user name or password".into());
    }
    let host = host_of(authority).unwrap_or_default();
    if host.is_empty() {
        return Err("remote_server_url has no host".into());
    }
    if secure || is_local_host(&host) {
        Ok(())
    } else {
        Err(format!(
            "plain http is only allowed for localhost or a private LAN address, not {host}; \
             use https because the token is a bearer secret"
        ))
    }
}

fn host_of(authority: &str) -> Option<String> {
    if let Some(rest) = authority.strip_prefix('[') {
        return Some(rest[..rest.find(']')?].to_string());
    }
    Some(authority.split(':').next().unwrap_or_default().to_string())
}

fn is_local_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        // 127.0.0.0/8, 10/8, 172.16/12, 192.168/16.
        return ip.is_loopback() || ip.is_private();
    }
    host.parse::<std::net::Ipv6Addr>()
        .is_ok_and(|ip| ip.is_loopback())
}

fn endpoint_for(url: &str) -> String {
    let base = url.trim().trim_end_matches('/');
    if base.to_ascii_lowercase().ends_with(WIDGET_PATH) {
        base.to_string()
    } else {
        format!("{base}{WIDGET_PATH}")
    }
}

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// `GET /api/v1/widget`. Unknown fields (email, plan, card_theme) are ignored.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Payload {
    #[serde(default, deserialize_with = "null_as_default")]
    pub schema: i64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub revision: i64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub manager_url: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub accounts: Vec<RemoteAccount>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RemoteAccount {
    #[serde(default, deserialize_with = "null_as_default")]
    pub id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub status: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub status_message: String,
    #[serde(default)]
    pub usage: Option<RemoteUsage>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RemoteUsage {
    #[serde(default)]
    pub session: Option<RemoteSection>,
    #[serde(default)]
    pub weekly: Option<RemoteSection>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RemoteSection {
    #[serde(default, deserialize_with = "null_as_default")]
    pub available: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub percentage: f64,
    #[serde(default)]
    pub resets_at_unix: Option<i64>,
}

/// Parse a payload and drop accounts whose id cannot be a theme binding
/// (`accounts.claude.<id>.*` accepts `[A-Za-z0-9_]`) or is a duplicate.
pub fn parse_payload(body: &str) -> Result<Payload, FetchError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|error| FetchError::Parse(error.to_string()))?;
    // serde would also accept a positional array; the contract is an object
    // that always carries an `accounts` array (another service at a wrong URL
    // must not look like "zero accounts").
    if !value
        .get("accounts")
        .is_some_and(serde_json::Value::is_array)
    {
        return Err(FetchError::Parse(
            "expected a JSON object with an accounts array".into(),
        ));
    }
    let mut payload: Payload =
        serde_json::from_value(value).map_err(|error| FetchError::Parse(error.to_string()))?;
    let mut seen = std::collections::HashSet::new();
    payload.accounts.retain(|account| {
        let id = account.id.as_str();
        let valid = !id.is_empty()
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && seen.insert(id.to_ascii_lowercase());
        if !valid {
            crate::diagnose::log(format!("remote: ignoring account with invalid id {id:?}"));
        }
        valid
    });
    Ok(payload)
}

fn section(section: Option<&RemoteSection>) -> UsageSection {
    let Some(section) = section else {
        return UsageSection::default();
    };
    UsageSection {
        available: section.available,
        percentage: if section.percentage.is_finite() {
            section.percentage
        } else {
            0.0
        },
        resets_at: section
            .resets_at_unix
            .filter(|unix| *unix > 0)
            .and_then(|unix| UNIX_EPOCH.checked_add(Duration::from_secs(unix as u64))),
    }
}

pub fn usage_data(usage: &RemoteUsage) -> UsageData {
    UsageData {
        session: section(usage.session.as_ref()),
        weekly: section(usage.weekly.as_ref()),
        ..Default::default()
    }
}

/// What one server account means to the widget. `expired` and `logged_out`
/// become the errors a local expired / missing login produces, so
/// `login_required` and the tooltip work unchanged.
pub fn account_result(account: &RemoteAccount) -> (Option<UsageData>, Option<PollError>) {
    let usage = account.usage.as_ref().map(usage_data);
    let stale = |usage: Option<UsageData>| {
        usage.map(|mut usage| {
            usage.stale = true;
            usage
        })
    };
    match account.status.trim().to_ascii_lowercase().as_str() {
        "ok" => match usage {
            Some(usage) => (Some(usage), None),
            // The server has not fetched this account yet.
            None => (None, Some(PollError::RequestFailed)),
        },
        "expired" => (None, Some(PollError::TokenExpired)),
        "logged_out" => (None, Some(PollError::NoCredentials)),
        // The server keeps its last good reading: show it as stale.
        "error" => (stale(usage), Some(PollError::RequestFailed)),
        _ => (stale(usage), Some(PollError::UnexpectedResponse)),
    }
}

pub fn profiles(payload: &Payload) -> Vec<AccountProfile> {
    payload
        .accounts
        .iter()
        .map(|account| AccountProfile {
            id: account.id.clone(),
            name: if account.name.trim().is_empty() {
                account.id.clone()
            } else {
                account.name.trim().to_string()
            },
            config_dir: String::new(),
            credentials_path: String::new(),
            enabled: true,
        })
        .collect()
}

fn provider_accounts(profiles: Vec<AccountProfile>) -> ProviderAccounts {
    ProviderAccounts {
        selected: profiles
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_default(),
        used_ids: profiles.iter().map(|profile| profile.id.clone()).collect(),
        profiles,
    }
}

/// Precedence: remote mode > `accounts.db` > `settings.json` profiles.
/// `remote` is `Some` whenever remote mode is on, even before the first
/// fetch (zero accounts then, never a local fallback).
pub fn resolve(
    accounts: &AccountSettings,
    remote: Option<Vec<AccountProfile>>,
    local: impl FnOnce() -> AccountSettings,
) -> AccountSettings {
    match remote {
        Some(profiles) => {
            let mut effective = accounts.clone();
            effective.claude = provider_accounts(profiles);
            effective
        }
        None => local(),
    }
}

/// Usage-source signature for a remote account: changes with url, token and id.
fn source_signature(config: &RemoteConfig, id: &str) -> String {
    format!(
        "{SIGNATURE_PREFIX}{}",
        fingerprint(&format!("{}\n{id}", config.key()))
    )
}

pub fn is_remote_signature(signature: &str) -> bool {
    signature.starts_with(SIGNATURE_PREFIX)
}

/// One `AccountUsage` per configured remote profile. A failed fetch gives
/// every account the same error; transient ones keep the last reading stale
/// through the normal carry-forward rules (same signature).
pub fn account_usages(
    config: &RemoteConfig,
    profiles: &[AccountProfile],
    outcome: &Result<Payload, FetchError>,
) -> Vec<AccountUsage> {
    profiles
        .iter()
        .filter(|profile| profile.enabled)
        .filter_map(|profile| {
            let (usage, error) = match outcome {
                Ok(payload) => account_result(
                    payload
                        .accounts
                        .iter()
                        .find(|account| account.id == profile.id)?,
                ),
                Err(error) => (None, Some(error.poll_error())),
            };
            Some(AccountUsage {
                provider: ProviderId::Claude,
                profile: profile.clone(),
                source_signature: source_signature(config, &profile.id),
                source_path: None,
                usage,
                error,
                selected: false,
            })
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The URL may not receive the token (plain http off the LAN, bad scheme).
    InsecureUrl(String),
    /// 401 (or 403): missing, unknown or revoked token.
    Unauthorized(u16),
    Http(u16),
    Network(String),
    Parse(String),
}

impl FetchError {
    pub fn poll_error(&self) -> PollError {
        match self {
            Self::InsecureUrl(_) => PollError::InsecureServerUrl,
            Self::Unauthorized(_) => PollError::ServerTokenRejected,
            Self::Http(code) => PollError::HttpStatus(*code),
            Self::Network(_) => PollError::NetworkError,
            Self::Parse(_) => PollError::UnexpectedResponse,
        }
    }

    /// The kind of failure, without volatile detail, for change detection.
    fn kind(&self) -> String {
        match self {
            Self::InsecureUrl(_) => "insecure_url".into(),
            Self::Unauthorized(_) => "unauthorized".into(),
            Self::Http(code) => format!("http_{code}"),
            Self::Network(_) => "network".into(),
            Self::Parse(_) => "parse".into(),
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InsecureUrl(reason) => write!(f, "server URL rejected: {reason}"),
            Self::Unauthorized(code) => write!(f, "server token rejected (HTTP {code})"),
            Self::Http(code) => write!(f, "server answered HTTP {code}"),
            Self::Network(error) => write!(f, "server unreachable: {error}"),
            Self::Parse(error) => write!(f, "unexpected server response: {error}"),
        }
    }
}

fn build_agent(timeout: Duration) -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    let builder = ureq::Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT.min(timeout)))
        .timeout_global(Some(timeout))
        .tls_config(tls)
        .http_status_as_error(false)
        // Never follow a redirect with the bearer token.
        .max_redirects(0)
        .max_redirects_will_error(false);
    // Tests talk to 127.0.0.1 directly, whatever proxy the machine has.
    #[cfg(test)]
    let builder = builder.proxy(None);
    builder.build().into()
}

fn agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| build_agent(REQUEST_TIMEOUT)).clone()
}

pub fn fetch(config: &RemoteConfig) -> Result<Payload, FetchError> {
    let endpoint = config.endpoint().map_err(FetchError::InsecureUrl)?;
    fetch_endpoint(&agent(), &endpoint, config.token.expose())
}

fn fetch_endpoint(agent: &ureq::Agent, endpoint: &str, token: &str) -> Result<Payload, FetchError> {
    let mut response = agent
        .get(endpoint)
        .header("Authorization", &format!("Bearer {token}"))
        .header("Accept", "application/json")
        .call()
        .map_err(|error| FetchError::Network(error.to_string()))?;
    match response.status().as_u16() {
        200 => {}
        code @ (401 | 403) => return Err(FetchError::Unauthorized(code)),
        code => return Err(FetchError::Http(code)),
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BODY_BYTES)
        .read_to_string()
        .map_err(|error| FetchError::Network(error.to_string()))?;
    parse_payload(&body)
}

/// What a fetch said, reduced to what decides whether the widget must reload.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Outcome {
    Fetched {
        revision: i64,
        manager_url: String,
        accounts: Vec<(String, String)>,
    },
    Failed(String),
}

fn outcome_of(result: &Result<Payload, FetchError>) -> Outcome {
    match result {
        Ok(payload) => Outcome::Fetched {
            revision: payload.revision,
            manager_url: payload.manager_url.clone(),
            accounts: payload
                .accounts
                .iter()
                .map(|account| (account.id.clone(), account.name.clone()))
                .collect(),
        },
        Err(error) => Outcome::Failed(error.kind()),
    }
}

/// Refetch/apply decision of the 30 s check: reload the widget when the
/// revision (or account list) changed, or when the server went from
/// answering to failing, recovered, or started failing differently.
fn should_reload(previous: Option<&Outcome>, current: &Outcome) -> bool {
    previous != Some(current)
}

#[derive(Serialize, Deserialize)]
struct PersistedAccount {
    id: String,
    name: String,
}

/// The account list survives restarts (and reaches the Theme Studio process)
/// without the token or any usage data.
#[derive(Serialize, Deserialize)]
struct Persisted {
    key: String,
    revision: i64,
    manager_url: String,
    accounts: Vec<PersistedAccount>,
}

fn snapshot_path() -> std::path::PathBuf {
    crate::app_settings::app_data_directory().join(SNAPSHOT_FILE)
}

#[derive(Debug, Default)]
struct Tracker {
    config: Option<RemoteConfig>,
    /// Last successful payload (or the persisted account list at startup).
    payload: Option<Payload>,
    /// When `payload` came from the network; `None` for the persisted copy.
    fetched_at: Option<Instant>,
    last: Option<Outcome>,
}

impl Tracker {
    const fn new() -> Self {
        Self {
            config: None,
            payload: None,
            fetched_at: None,
            last: None,
        }
    }

    /// Adopt the current settings. Returns `true` when remote mode was
    /// switched on/off or its url/token changed.
    fn sync(&mut self, config: Option<&RemoteConfig>) -> bool {
        if self.config.as_ref() == config {
            return false;
        }
        *self = Self::new();
        if let Some(config) = config {
            self.config = Some(config.clone());
            self.payload = load_persisted(&config.key());
            crate::diagnose::log(format!(
                "remote: mode on, server={} accounts_from_disk={}",
                config.url,
                self.payload
                    .as_ref()
                    .map(|payload| payload.accounts.len())
                    .unwrap_or(0)
            ));
        } else {
            crate::diagnose::log("remote: mode off");
        }
        true
    }

    fn record(&mut self, result: &Result<Payload, FetchError>) -> bool {
        let outcome = outcome_of(result);
        let changed = should_reload(self.last.as_ref(), &outcome);
        if let Ok(payload) = result {
            if changed {
                if let Some(config) = &self.config {
                    persist(&config.key(), payload);
                }
            }
            self.payload = Some(payload.clone());
            self.fetched_at = Some(Instant::now());
        }
        self.last = Some(outcome);
        changed
    }

    fn recent(&self, window: Duration) -> Option<Payload> {
        self.fetched_at
            .filter(|at| at.elapsed() < window)
            .and(self.payload.clone())
    }

    fn profiles(&self) -> Vec<AccountProfile> {
        self.payload.as_ref().map(profiles).unwrap_or_default()
    }
}

fn load_persisted(key: &str) -> Option<Payload> {
    let text = std::fs::read_to_string(snapshot_path()).ok()?;
    let persisted: Persisted = serde_json::from_str(&text).ok()?;
    (persisted.key == key).then(|| Payload {
        schema: 1,
        revision: persisted.revision,
        manager_url: persisted.manager_url,
        accounts: persisted
            .accounts
            .into_iter()
            .map(|account| RemoteAccount {
                id: account.id,
                name: account.name,
                ..Default::default()
            })
            .collect(),
    })
}

fn persist(key: &str, payload: &Payload) {
    let persisted = Persisted {
        key: key.into(),
        revision: payload.revision,
        manager_url: payload.manager_url.clone(),
        accounts: payload
            .accounts
            .iter()
            .map(|account| PersistedAccount {
                id: account.id.clone(),
                name: account.name.clone(),
            })
            .collect(),
    };
    if let Err(error) = crate::app_settings::write_json_atomic(&snapshot_path(), &persisted) {
        crate::diagnose::log_error("remote: unable to save the account list", error);
    }
}

static TRACKER: Mutex<Tracker> = Mutex::new(Tracker::new());

fn with_tracker<T>(f: impl FnOnce(&mut Tracker) -> T) -> T {
    let mut tracker = TRACKER.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut tracker)
}

/// The account settings the monitor should use, applying the precedence
/// remote > accounts.db > settings.json. Never touches the network.
pub fn effective(settings: &SettingsFile) -> AccountSettings {
    let config = RemoteConfig::from_settings(settings);
    let remote = with_tracker(|tracker| {
        tracker.sync(config.as_ref());
        config.is_some().then(|| tracker.profiles())
    });
    resolve(&settings.accounts, remote, || {
        crate::accounts_db::effective(&settings.accounts)
    })
}

/// The remote configuration the running widget adopted with its accounts.
pub fn active_config() -> Option<RemoteConfig> {
    with_tracker(|tracker| tracker.config.clone())
}

fn log_fetch(endpoint: &str, result: &Result<Payload, FetchError>) {
    match result {
        Ok(payload) => crate::diagnose::log_lazy(|| {
            format!(
                "remote: GET {endpoint} -> schema={} revision={} accounts=[{}]",
                payload.schema,
                payload.revision,
                payload
                    .accounts
                    .iter()
                    .map(|account| {
                        let usage = account.usage.as_ref().map(usage_data);
                        format!(
                            "{}({}) status={} session={} weekly={}",
                            account.id,
                            account.name,
                            account.status,
                            usage
                                .as_ref()
                                .map(|usage| format!("{}%", usage.session.percentage))
                                .unwrap_or_else(|| "-".into()),
                            usage
                                .as_ref()
                                .map(|usage| format!("{}%", usage.weekly.percentage))
                                .unwrap_or_else(|| "-".into()),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }),
        Err(error) => crate::diagnose::log(format!("remote: GET {endpoint} failed: {error}")),
    }
}

fn fetch_and_record(config: &RemoteConfig) -> (Result<Payload, FetchError>, bool) {
    let endpoint = config
        .endpoint()
        .unwrap_or_else(|_| endpoint_for(&config.url));
    let result = fetch(config);
    log_fetch(&endpoint, &result);
    let changed = with_tracker(|tracker| {
        (tracker.config.as_ref() == Some(config)) && tracker.record(&result)
    });
    (result, changed)
}

/// One poll cycle for the Claude provider in remote mode. `Err` only when
/// the server failed and there is no account to attach the error to.
pub fn poll_accounts(
    config: &RemoteConfig,
    claude: &ProviderAccounts,
) -> Result<Vec<AccountUsage>, PollError> {
    let reused = with_tracker(|tracker| {
        (tracker.config.as_ref() == Some(config))
            .then(|| tracker.recent(REUSE_WINDOW))
            .flatten()
    });
    let result = match reused {
        Some(payload) => {
            crate::diagnose::log(format!(
                "remote: poll reuses revision={} fetched under {}s ago",
                payload.revision,
                REUSE_WINDOW.as_secs()
            ));
            Ok(payload)
        }
        None => fetch_and_record(config).0,
    };
    let usages = account_usages(config, &claude.profiles, &result);
    match result {
        Err(error) if usages.is_empty() => Err(error.poll_error()),
        _ => Ok(usages),
    }
}

/// The 30 s check (run off the UI thread). Re-reads `settings.json`, asks the
/// server, and returns `true` when the widget must reload accounts and poll:
/// remote mode toggled, url/token changed, revision or accounts changed, or
/// the server started/stopped failing.
pub fn check_for_changes() -> bool {
    let settings = crate::app_settings::load_settings();
    let config = RemoteConfig::from_settings(&settings);
    let toggled = with_tracker(|tracker| tracker.sync(config.as_ref()));
    let Some(config) = config else {
        return toggled;
    };
    let previous = with_tracker(|tracker| tracker.last.clone());
    let (_, changed) = fetch_and_record(&config);
    if changed {
        let current = with_tracker(|tracker| tracker.last.clone());
        crate::diagnose::log(format!(
            "remote: revision check found a change {previous:?} -> {current:?}"
        ));
    }
    toggled || changed
}

/// `true` when the server's account list differs from the accounts the
/// widget is showing (for example after the first fetch).
pub fn profiles_differ(current: &AccountSettings) -> bool {
    with_tracker(|tracker| {
        tracker.config.is_some()
            && tracker.payload.is_some()
            && tracker.profiles() != current.claude.profiles
    })
}

/// The "Manage accounts" target: the server's `manager_url` in remote mode
/// (falling back to `remote_server_url`), otherwise `accounts.db`'s.
pub fn manager_url() -> String {
    let settings = crate::app_settings::load_settings();
    let Some(config) = RemoteConfig::from_settings(&settings) else {
        return crate::accounts_db::manager_url();
    };
    let from_server = with_tracker(|tracker| {
        tracker.sync(Some(&config));
        tracker
            .payload
            .as_ref()
            .map(|payload| payload.manager_url.trim().to_string())
    });
    manager_url_for(&config, from_server)
}

fn manager_url_for(config: &RemoteConfig, from_server: Option<String>) -> String {
    from_server
        .filter(|url| crate::context_menu::supported_url(url))
        .unwrap_or_else(|| config.url.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const FULL: &str = r#"{
      "schema": 1,
      "revision": 12,
      "updated_unix": 1790240810,
      "manager_url": "https://claude.example.com",
      "card_theme": "auto",
      "accounts": [
        {
          "id": "ba", "name": "BA", "email": "x@y", "plan": "max",
          "status": "ok", "status_message": "",
          "usage": {
            "session": { "available": true, "percentage": 12.0, "resets_at_unix": 1790248799 },
            "weekly":  { "available": true, "percentage": 44.0, "resets_at_unix": 1790456399 }
          }
        },
        { "id": "kv", "name": "kv", "status": "expired", "status_message": "token expired",
          "usage": null },
        { "id": "lo", "name": null, "status": "logged_out" },
        { "id": "er", "name": "er", "status": "error", "status_message": "429",
          "usage": { "session": { "available": true, "percentage": 80, "resets_at_unix": null },
                     "weekly": null } },
        { "id": "zz", "name": "zz", "status": "something_new" }
      ]
    }"#;

    fn config(url: &str) -> RemoteConfig {
        RemoteConfig {
            url: url.into(),
            token: SecretToken::new("secret-token-value"),
        }
    }

    fn account<'a>(payload: &'a Payload, id: &str) -> &'a RemoteAccount {
        payload.accounts.iter().find(|a| a.id == id).unwrap()
    }

    #[test]
    fn full_payload_parses_and_maps_to_usage() {
        let payload = parse_payload(FULL).unwrap();
        assert_eq!(payload.schema, 1);
        assert_eq!(payload.revision, 12);
        assert_eq!(payload.manager_url, "https://claude.example.com");
        assert_eq!(payload.accounts.len(), 5);
        let (usage, error) = account_result(account(&payload, "ba"));
        assert_eq!(error, None);
        let usage = usage.unwrap();
        assert!(!usage.stale);
        assert!(usage.session.available);
        assert_eq!(usage.session.percentage, 12.0);
        assert_eq!(
            usage.session.resets_at,
            Some(UNIX_EPOCH + Duration::from_secs(1_790_248_799))
        );
        assert_eq!(usage.weekly.percentage, 44.0);
        assert_eq!(
            usage.weekly.resets_at,
            Some(UNIX_EPOCH + Duration::from_secs(1_790_456_399))
        );
        assert_eq!(
            profiles(&payload)
                .iter()
                .map(|p| (p.id.as_str(), p.name.as_str()))
                .collect::<Vec<_>>(),
            [
                ("ba", "BA"),
                ("kv", "kv"),
                ("lo", "lo"),
                ("er", "er"),
                ("zz", "zz")
            ]
        );
        assert!(profiles(&payload)
            .iter()
            .all(|p| p.enabled && p.config_dir.is_empty() && p.credentials_path.is_empty()));
    }

    #[test]
    fn missing_usage_and_statuses_map_to_the_local_errors() {
        let payload = parse_payload(FULL).unwrap();
        assert_eq!(
            account_result(account(&payload, "kv")),
            (None, Some(PollError::TokenExpired))
        );
        assert_eq!(
            account_result(account(&payload, "lo")),
            (None, Some(PollError::NoCredentials))
        );
        let (usage, error) = account_result(account(&payload, "er"));
        assert_eq!(error, Some(PollError::RequestFailed));
        let usage = usage.unwrap();
        assert!(usage.stale, "the server's last reading is shown as stale");
        assert_eq!(usage.session.percentage, 80.0);
        assert_eq!(usage.session.resets_at, None);
        assert!(!usage.weekly.available);
        // Unknown status: not a login problem, just an unexpected answer.
        assert_eq!(
            account_result(account(&payload, "zz")),
            (None, Some(PollError::UnexpectedResponse))
        );
        // status ok but usage never fetched yet.
        let pending = RemoteAccount {
            id: "p".into(),
            status: "ok".into(),
            ..Default::default()
        };
        assert_eq!(
            account_result(&pending),
            (None, Some(PollError::RequestFailed))
        );
        // Minimal payloads and nulls are accepted.
        let empty = parse_payload(r#"{"revision":3,"accounts":[],"manager_url":null}"#).unwrap();
        assert_eq!(empty.revision, 3);
        assert!(empty.accounts.is_empty());
        assert!(parse_payload(r#"{"revision":3,"accounts":null}"#).is_err());
        assert!(parse_payload("{}").is_err());
        assert!(parse_payload("not json").is_err());
        assert!(matches!(parse_payload("[1,2]"), Err(FetchError::Parse(_))));
    }

    #[test]
    fn invalid_and_duplicate_ids_are_dropped() {
        let payload = parse_payload(
            r#"{"accounts":[{"id":"ok_1","status":"ok"},{"id":"bad-id"},{"id":""},
               {"id":"OK_1"},{"name":"no id"}]}"#,
        )
        .unwrap();
        assert_eq!(
            payload
                .accounts
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            ["ok_1"]
        );
    }

    #[test]
    fn remote_errors_drive_login_required_through_the_theme_context() {
        let config = config("https://claude.example.com");
        let payload = parse_payload(FULL).unwrap();
        let accounts = AccountSettings {
            claude: provider_accounts(profiles(&payload)),
            ..Default::default()
        };
        let mut data = crate::models::AppUsageData::default();
        data.accounts = account_usages(&config, &accounts.claude.profiles, &Ok(payload));
        data.select_accounts(&accounts);
        assert_eq!(data.accounts.len(), 5);
        let context = crate::theme_engine::DataContext::from_usage(
            Some(&data),
            &crate::theme_engine::Canvas::default(),
        );
        let value = |expression: &str| {
            crate::theme_engine::evaluate(expression, &context).unwrap_or(f64::NAN)
        };
        assert_eq!(value("accounts.claude.ba.login_required"), 0.0);
        assert_eq!(value("accounts.claude.ba.session.percentage"), 12.0);
        assert_eq!(value("accounts.claude.kv.login_required"), 1.0);
        assert_eq!(value("accounts.claude.lo.login_required"), 1.0);
        assert_eq!(value("accounts.claude.er.login_required"), 0.0);
        assert_eq!(value("accounts.claude.er.has_error"), 1.0);
        assert_eq!(value("accounts.claude.zz.login_required"), 0.0);
        // The first server account is the selected one for claude.* bindings.
        assert_eq!(value("claude.login_required"), 0.0);
        assert_eq!(value("claude.session.percentage"), 12.0);
    }

    #[test]
    fn fetch_failures_attach_to_every_account_and_keep_stale_readings() {
        let config = config("https://claude.example.com");
        let payload = parse_payload(FULL).unwrap();
        let accounts = AccountSettings {
            claude: provider_accounts(profiles(&payload)),
            ..Default::default()
        };
        let good = account_usages(&config, &accounts.claude.profiles, &Ok(payload));
        let mut previous = crate::models::AppUsageData::default();
        previous.accounts = good;

        for (error, expected, keeps_reading) in [
            (
                FetchError::Network("timed out".into()),
                PollError::NetworkError,
                true,
            ),
            (FetchError::Http(503), PollError::HttpStatus(503), true),
            (
                FetchError::Unauthorized(401),
                PollError::ServerTokenRejected,
                true,
            ),
            (
                FetchError::InsecureUrl("x".into()),
                PollError::InsecureServerUrl,
                false,
            ),
        ] {
            let mut fresh = crate::models::AppUsageData::default();
            fresh.accounts =
                account_usages(&config, &accounts.claude.profiles, &Err(error.clone()));
            assert!(fresh
                .accounts
                .iter()
                .all(|a| a.error == Some(expected) && a.usage.is_none()));
            assert!(!expected.is_auth(), "{error}: not a Claude login problem");
            let merged = crate::poller::carry_forward_failures(
                fresh,
                &previous,
                crate::providers::ProviderSet::from_enabled([ProviderId::Claude]),
            );
            let ba = merged
                .accounts
                .iter()
                .find(|a| a.profile.id == "ba")
                .unwrap();
            assert_eq!(ba.usage.is_some(), keeps_reading, "{error}");
            if keeps_reading {
                assert!(ba.usage.as_ref().unwrap().stale);
                assert_eq!(ba.usage.as_ref().unwrap().session.percentage, 12.0);
            }
        }
        assert!(PollError::ServerTokenRejected
            .message(crate::localization::LanguageId::English)
            .contains("Server token rejected"));
    }

    #[test]
    fn precedence_is_remote_then_database_then_settings() {
        let mut settings = AccountSettings::default();
        settings.claude.profiles[0].config_dir = "C:\\settings-claude".into();
        settings.codex.profiles[0].config_dir = "C:\\codex".into();
        let db = crate::accounts_db::Source::Present(crate::accounts_db::Snapshot {
            revision: 1,
            manager_url: crate::accounts_db::DEFAULT_MANAGER_URL.into(),
            profiles: vec![AccountProfile {
                id: "db_account".into(),
                name: "db".into(),
                config_dir: "C:\\Users\\me\\.claude-db".into(),
                credentials_path: String::new(),
                enabled: true,
            }],
        });
        let local = |source: crate::accounts_db::Source| {
            let settings = settings.clone();
            move || {
                let mut applied = settings.clone();
                crate::accounts_db::apply(&source, &mut applied);
                applied
            }
        };
        let remote = vec![AccountProfile {
            id: "server".into(),
            name: "Server".into(),
            config_dir: String::new(),
            credentials_path: String::new(),
            enabled: true,
        }];

        let resolved = resolve(&settings, Some(remote.clone()), local(db.clone()));
        assert_eq!(resolved.claude.profiles, remote);
        assert_eq!(resolved.claude.selected, "server");
        assert_eq!(resolved.codex, settings.codex, "other providers unchanged");

        // Remote mode with nothing fetched yet: zero accounts, no local fallback.
        let resolved = resolve(&settings, Some(Vec::new()), local(db.clone()));
        assert!(resolved.claude.profiles.is_empty());

        let resolved = resolve(&settings, None, local(db));
        assert_eq!(resolved.claude.profiles[0].id, "db_account");

        let resolved = resolve(&settings, None, local(crate::accounts_db::Source::Absent));
        assert_eq!(resolved, settings);
    }

    #[test]
    fn settings_keys_default_and_the_token_is_never_debug_printed() {
        let old: SettingsFile = serde_json::from_str(r#"{"poll_interval_ms":900000}"#).unwrap();
        assert!(old.remote_server_url.is_empty() && old.remote_server_token.is_empty());
        assert!(RemoteConfig::from_settings(&old).is_none());
        let json = serde_json::to_value(&old).unwrap();
        assert!(json.get("remote_server_url").is_none());
        assert!(json.get("remote_server_token").is_none());

        let mut settings = old.clone();
        settings.remote_server_url = " https://claude.example.com ".into();
        assert!(
            RemoteConfig::from_settings(&settings).is_none(),
            "url alone is not remote mode"
        );
        settings.remote_server_token = SecretToken::new("top-secret-123");
        let config = RemoteConfig::from_settings(&settings).unwrap();
        assert_eq!(config.url, "https://claude.example.com");
        let round_trip: SettingsFile =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert_eq!(round_trip.remote_server_token, settings.remote_server_token);
        for printed in [
            format!("{settings:?}"),
            format!("{config:?}"),
            format!("{:?}", settings.remote_server_token),
        ] {
            assert!(!printed.contains("top-secret-123"), "{printed}");
        }
        assert!(!source_signature(&config, "ba").contains("top-secret-123"));
        assert!(is_remote_signature(&source_signature(&config, "ba")));
    }

    #[test]
    fn only_https_or_local_plain_http_may_receive_the_token() {
        for ok in [
            "https://claude.example.com",
            "HTTPS://claude.example.com:8443/base/",
            "http://127.0.0.1:47591",
            "http://127.5.6.7",
            "http://localhost:3000/",
            "http://192.168.0.10:3000",
            "http://10.0.0.8",
            "http://172.16.0.1",
            "http://172.31.255.255:80",
            "http://[::1]:47591",
        ] {
            assert_eq!(validate_url(ok), Ok(()), "{ok}");
        }
        for rejected in [
            "http://claude.example.com",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://172.15.0.1",
            "http://192.169.0.1",
            "http://127.0.0.1.evil.example",
            "http://localhost.evil.example",
            "http://user:pass@127.0.0.1",
            "https://user@claude.example.com",
            "ftp://127.0.0.1",
            "claude.example.com",
            "https://",
            "http://[2001:db8::1]",
        ] {
            assert!(validate_url(rejected).is_err(), "{rejected}");
        }
        assert_eq!(
            config("https://h.example/").endpoint().unwrap(),
            "https://h.example/api/v1/widget"
        );
        assert_eq!(
            config("https://h.example/api/v1/widget")
                .endpoint()
                .unwrap(),
            "https://h.example/api/v1/widget"
        );
        assert!(config("http://h.example").endpoint().is_err());
        assert!(matches!(
            fetch(&config("http://h.example")),
            Err(FetchError::InsecureUrl(_))
        ));
    }

    #[test]
    fn revision_refetch_decision() {
        let payload = |revision, ids: &[&str]| Payload {
            revision,
            accounts: ids
                .iter()
                .map(|id| RemoteAccount {
                    id: (*id).into(),
                    name: (*id).into(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let r12 = outcome_of(&Ok(payload(12, &["ba"])));
        assert!(should_reload(None, &r12), "first answer");
        assert!(!should_reload(
            Some(&r12),
            &outcome_of(&Ok(payload(12, &["ba"])))
        ));
        assert!(should_reload(
            Some(&r12),
            &outcome_of(&Ok(payload(13, &["ba"])))
        ));
        assert!(should_reload(
            Some(&r12),
            &outcome_of(&Ok(payload(12, &["ba", "kv"])))
        ));
        let down = outcome_of(&Err(FetchError::Network("refused".into())));
        assert!(should_reload(Some(&r12), &down), "went unreachable");
        assert!(!should_reload(
            Some(&down),
            &outcome_of(&Err(FetchError::Network("timed out".into())))
        ));
        let rejected = outcome_of(&Err(FetchError::Unauthorized(401)));
        assert!(should_reload(Some(&down), &rejected));
        assert!(should_reload(Some(&rejected), &r12), "recovered");

        // The tracker applies the same rule and keeps the last good payload.
        let mut tracker = Tracker::new();
        assert!(tracker.record(&Ok(payload(12, &["ba"]))));
        assert!(!tracker.record(&Ok(payload(12, &["ba"]))));
        assert!(tracker.recent(REUSE_WINDOW).is_some());
        assert!(tracker.record(&Err(FetchError::Http(502))));
        assert_eq!(tracker.profiles()[0].id, "ba", "last good accounts kept");
        assert!(tracker.record(&Ok(payload(13, &["ba"]))));
        assert!(tracker.recent(Duration::ZERO).is_none());
    }

    #[test]
    fn manager_url_prefers_the_server_then_the_configured_url() {
        let config = config("https://claude.example.com");
        assert_eq!(
            manager_url_for(&config, Some("https://manage.example.com".into())),
            "https://manage.example.com"
        );
        assert_eq!(
            manager_url_for(&config, Some(String::new())),
            "https://claude.example.com"
        );
        assert_eq!(
            manager_url_for(&config, Some("javascript:alert(1)".into())),
            "https://claude.example.com"
        );
        assert_eq!(manager_url_for(&config, None), "https://claude.example.com");
    }

    /// Serve one canned HTTP response and return the request head it received.
    fn serve_once(response: Option<&'static str>) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            match response {
                Some(response) => {
                    let _ = stream.write_all(response.as_bytes());
                }
                // Never answer: the client must time out.
                None => std::thread::sleep(Duration::from_millis(1_500)),
            }
            String::from_utf8_lossy(&request).into_owned()
        });
        (format!("http://{address}/api/v1/widget"), handle)
    }

    fn get(endpoint: &str, timeout: Duration) -> Result<Payload, FetchError> {
        fetch_endpoint(&build_agent(timeout), endpoint, "secret-token-value")
    }

    fn http(status: &str, body: &str) -> &'static str {
        Box::leak(
            format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .into_boxed_str(),
        )
    }

    #[test]
    fn a_200_is_parsed_and_the_bearer_token_is_sent() {
        let (endpoint, server) = serve_once(Some(http("200 OK", FULL)));
        let payload = get(&endpoint, Duration::from_secs(5)).unwrap();
        assert_eq!(payload.revision, 12);
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /api/v1/widget "), "{request}");
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer secret-token-value"),
            "{request}"
        );
    }

    #[test]
    fn a_401_is_a_rejected_token_and_5xx_is_an_http_error() {
        let (endpoint, server) = serve_once(Some(http("401 Unauthorized", "{}")));
        let error = get(&endpoint, Duration::from_secs(5)).unwrap_err();
        server.join().unwrap();
        assert_eq!(error, FetchError::Unauthorized(401));
        assert_eq!(error.poll_error(), PollError::ServerTokenRejected);
        assert_eq!(error.to_string(), "server token rejected (HTTP 401)");

        let (endpoint, server) = serve_once(Some(http("503 Service Unavailable", "down")));
        let error = get(&endpoint, Duration::from_secs(5)).unwrap_err();
        server.join().unwrap();
        assert_eq!(error, FetchError::Http(503));
        assert!(error.poll_error().is_transient());

        let (endpoint, server) = serve_once(Some(
            "HTTP/1.1 302 Found\r\nLocation: http://8.8.8.8/steal\r\nContent-Length: 0\r\n\r\n",
        ));
        assert_eq!(
            get(&endpoint, Duration::from_secs(5)).unwrap_err(),
            FetchError::Http(302),
            "redirects are never followed with the token"
        );
        server.join().unwrap();

        let (endpoint, server) = serve_once(Some(http("200 OK", "<html>")));
        assert!(matches!(
            get(&endpoint, Duration::from_secs(5)),
            Err(FetchError::Parse(_))
        ));
        server.join().unwrap();
    }

    #[test]
    fn an_unanswered_request_times_out_quickly_and_a_closed_port_is_unreachable() {
        let (endpoint, server) = serve_once(None);
        let started = Instant::now();
        let error = get(&endpoint, Duration::from_millis(300)).unwrap_err();
        assert!(matches!(error, FetchError::Network(_)), "{error:?}");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(error.poll_error(), PollError::NetworkError);
        server.join().unwrap();

        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = closed.local_addr().unwrap();
        drop(closed);
        let error = get(
            &format!("http://{address}/api/v1/widget"),
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert!(matches!(error, FetchError::Network(_)), "{error:?}");
    }
}
