//! Accounts owned by the Account Manager web app.
//!
//! The web app keeps the account list in `accounts.db` (see
//! `docs/account-manager-contract.md`). When that database exists and carries a
//! `meta.schema` row, it replaces the Claude profiles from `settings.json`.
//! From schema 2 on, rows with `provider = 'codex'` also replace the Codex
//! profiles; a schema 1 database (or one without the `provider` column) only
//! ever holds Claude accounts and Codex keeps its `settings.json` profiles.
//! When the database is missing, unreadable or has no schema row, nothing
//! changes. The monitor only ever opens it read-only.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::accounts::{AccountProfile, AccountSettings, ProviderAccounts};
use crate::providers::ProviderId;
use crate::winsqlite::{self, Connection};

pub const DEFAULT_MANAGER_URL: &str = "http://127.0.0.1:47291";
/// Environment override for the database location (used for testing).
pub const PATH_OVERRIDE_VARIABLE: &str = "CCUM_ACCOUNTS_DB";
/// How often the widget checks `meta.revision`.
pub const REVISION_CHECK_INTERVAL_MS: u32 = 5_000;
/// A write by the web app holds the lock for milliseconds; never wait long.
const BUSY_TIMEOUT_MS: u32 = 250;
/// The first schema whose `provider` column makes the database own Codex accounts.
pub const CODEX_SCHEMA: i64 = 2;

const ACCOUNTS_QUERY: &str =
    "SELECT id, name, config_dir FROM accounts WHERE enabled = 1 ORDER BY sort_order, name";
const ACCOUNTS_WITH_PROVIDER_QUERY: &str = "SELECT id, name, config_dir, provider FROM accounts \
     WHERE enabled = 1 ORDER BY sort_order, name";

/// The accounts and settings read from one consistent database snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub schema: i64,
    pub revision: i64,
    pub manager_url: String,
    /// Claude profiles (every row of a database without a `provider` column).
    pub profiles: Vec<AccountProfile>,
    /// Codex profiles when the database owns them (schema >= 2), otherwise
    /// `None` and Codex keeps its `settings.json` profiles.
    pub codex_profiles: Option<Vec<AccountProfile>>,
}

/// What the database currently says about the account lists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// No usable database: keep using `settings.json`.
    Absent,
    Present(Snapshot),
}

/// `(schema, revision)`: a change in either reloads the accounts.
type Version = (i64, i64);

impl Source {
    #[cfg(test)]
    fn revision(&self) -> Option<i64> {
        self.version().map(|(_, revision)| revision)
    }

    fn version(&self) -> Option<Version> {
        match self {
            Source::Absent => None,
            Source::Present(snapshot) => Some((snapshot.schema, snapshot.revision)),
        }
    }
}

pub fn database_path() -> PathBuf {
    database_path_from(std::env::var_os(PATH_OVERRIDE_VARIABLE))
}

fn database_path_from(override_value: Option<std::ffi::OsString>) -> PathBuf {
    override_value
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::app_settings::app_data_directory().join("accounts.db"))
}

fn open(path: &Path) -> Result<Option<Connection>, winsqlite::Error> {
    if !path.is_file() {
        return Ok(None);
    }
    Connection::open_read_only_with_timeout(path, BUSY_TIMEOUT_MS).map(Some)
}

fn meta_table_exists(connection: &Connection) -> Result<bool, winsqlite::Error> {
    let mut exists = false;
    connection.query_rows(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
        |_| {
            exists = true;
            Ok(())
        },
    )?;
    Ok(exists)
}

fn meta_text(connection: &Connection, key: &str) -> Result<Option<String>, winsqlite::Error> {
    // Keys are compile-time constants; no user input reaches this statement.
    let mut value = None;
    connection.query_rows(
        &format!("SELECT value FROM meta WHERE key = '{key}'"),
        |row| {
            value = row.text(0)?;
            Ok(())
        },
    )?;
    Ok(value)
}

fn meta_integer(connection: &Connection, key: &str) -> Result<Option<i64>, winsqlite::Error> {
    let mut value = None;
    connection.query_rows(
        &format!("SELECT CAST(value AS INTEGER) FROM meta WHERE key = '{key}'"),
        |row| {
            value = row.integer(0);
            Ok(())
        },
    )?;
    Ok(value)
}

/// The schema as a number: `"2"` is 2; a present but non-numeric value is
/// treated as the original schema 1 so the database still counts as active.
fn meta_schema(connection: &Connection) -> Result<Option<i64>, winsqlite::Error> {
    Ok(meta_text(connection, "schema")?.map(|schema| schema.trim().parse().unwrap_or(1)))
}

/// `Some((schema, revision))` when the database is active, `None` when it is
/// absent or has no schema row. This is the cheap check run every few seconds.
fn read_version(path: &Path) -> Result<Option<Version>, winsqlite::Error> {
    let Some(connection) = open(path)? else {
        return Ok(None);
    };
    connection.execute("BEGIN")?;
    let version = match meta_table_exists(&connection)? {
        true => match meta_schema(&connection)? {
            Some(schema) => Some((schema, meta_integer(&connection, "revision")?.unwrap_or(0))),
            None => None,
        },
        false => None,
    };
    connection.execute("COMMIT")?;
    Ok(version)
}

/// `Some(revision)` when the database is active, `None` when it is absent or
/// has no schema row.
#[cfg(test)]
pub fn read_revision(path: &Path) -> Result<Option<i64>, winsqlite::Error> {
    Ok(read_version(path)?.map(|(_, revision)| revision))
}

fn has_provider_column(connection: &Connection) -> Result<bool, winsqlite::Error> {
    let mut found = false;
    connection.query_rows("PRAGMA table_info(accounts)", |row| {
        found |= row
            .text(1)?
            .is_some_and(|name| name.eq_ignore_ascii_case("provider"));
        Ok(())
    })?;
    Ok(found)
}

/// `claude` (or empty) and `codex`; anything else is a provider this widget
/// does not know and the row is skipped.
fn row_provider(value: Option<String>) -> Option<ProviderId> {
    match value.as_deref().map(str::trim) {
        None | Some("") => Some(ProviderId::Claude),
        Some(value) if value.eq_ignore_ascii_case("claude") => Some(ProviderId::Claude),
        Some(value) if value.eq_ignore_ascii_case("codex") => Some(ProviderId::Codex),
        Some(_) => None,
    }
}

/// Read the whole account list inside one read transaction, so the revision
/// and the rows always belong to the same write by the web app.
pub fn load(path: &Path) -> Result<Source, winsqlite::Error> {
    let Some(connection) = open(path)? else {
        return Ok(Source::Absent);
    };
    connection.execute("BEGIN")?;
    let schema = match meta_table_exists(&connection)? {
        true => meta_schema(&connection)?,
        false => None,
    };
    let Some(schema) = schema else {
        connection.execute("COMMIT")?;
        return Ok(Source::Absent);
    };
    let revision = meta_integer(&connection, "revision")?.unwrap_or(0);
    let manager_url = meta_text(&connection, "manager_url")?
        .map(|url| url.trim().to_string())
        .filter(|url| crate::context_menu::supported_url(url))
        .unwrap_or_else(|| DEFAULT_MANAGER_URL.into());
    let with_provider = has_provider_column(&connection)?;
    let owns_codex = schema >= CODEX_SCHEMA;
    let mut profiles = Vec::new();
    let mut codex_profiles = Vec::new();
    let mut ignored = Vec::new();
    let query = if with_provider {
        ACCOUNTS_WITH_PROVIDER_QUERY
    } else {
        ACCOUNTS_QUERY
    };
    connection.query_rows(query, |row| {
        let id = row.text(0)?.unwrap_or_default();
        let name = row.text(1)?.unwrap_or_default();
        let provider = if with_provider {
            row_provider(row.text(3)?)
        } else {
            Some(ProviderId::Claude)
        };
        let profile = AccountProfile {
            name: if name.trim().is_empty() {
                id.clone()
            } else {
                name
            },
            id,
            config_dir: row.text(2)?.unwrap_or_default(),
            credentials_path: String::new(),
            enabled: true,
        };
        match provider {
            Some(ProviderId::Claude) => profiles.push(profile),
            Some(ProviderId::Codex) if owns_codex => codex_profiles.push(profile),
            _ => ignored.push(profile.id),
        }
        Ok(())
    })?;
    connection.execute("COMMIT")?;
    if !ignored.is_empty() {
        crate::diagnose::log(format!(
            "accounts db: schema={schema} ignoring row(s) [{}] (unknown provider, or codex before schema {CODEX_SCHEMA})",
            ignored.join(", ")
        ));
    }
    Ok(Source::Present(Snapshot {
        schema,
        revision,
        manager_url,
        profiles,
        codex_profiles: owns_codex.then_some(codex_profiles),
    }))
}

/// Replace the Claude profiles (and, from schema 2 on, the Codex profiles)
/// with the database's lists. Every other provider keeps `settings.json`.
pub fn apply(source: &Source, accounts: &mut AccountSettings) {
    let Source::Present(snapshot) = source else {
        return;
    };
    accounts.claude = ProviderAccounts::from_profiles(snapshot.profiles.clone());
    if let Some(codex) = &snapshot.codex_profiles {
        accounts.codex = ProviderAccounts::from_profiles(codex.clone());
    }
}

/// Tracks the last database state seen by this process.
#[derive(Debug, Default)]
pub struct Tracker {
    current: Option<Source>,
}

impl Tracker {
    /// The known state, loading it on first use. A first read that fails
    /// falls back to `settings.json`; a later successful check replaces it.
    pub fn current(&mut self, path: &Path) -> &Source {
        self.current.get_or_insert_with(|| match load(path) {
            Ok(source) => {
                log_source(path, &source);
                source
            }
            Err(error) => {
                crate::diagnose::log(format!(
                    "accounts db: unreadable at {}: {error}; using settings.json accounts",
                    path.display()
                ));
                Source::Absent
            }
        })
    }

    /// Check the revision and reload on change. Returns `true` when the
    /// account list (or the database's presence) changed. Errors, such as the
    /// web app holding a write lock, keep the previous state for the next check.
    pub fn check(&mut self, path: &Path) -> bool {
        let Some(known) = self.current.as_ref() else {
            self.current(path);
            return true;
        };
        let version = match read_version(path) {
            Ok(version) => version,
            Err(error) => {
                crate::diagnose::log(format!(
                    "accounts db: revision check failed, retrying next tick: {error}"
                ));
                return false;
            }
        };
        if version == known.version() {
            return false;
        }
        let previous = known.version();
        match load(path) {
            Ok(source) => {
                let describe = |version: Option<Version>| match version {
                    Some((schema, revision)) => format!("revision={revision} schema={schema}"),
                    None => "inactive".into(),
                };
                crate::diagnose::log(format!(
                    "accounts db: revision changed {} -> {}",
                    describe(previous),
                    describe(source.version())
                ));
                log_source(path, &source);
                self.current = Some(source);
                true
            }
            Err(error) => {
                crate::diagnose::log(format!(
                    "accounts db: reload failed, retrying next tick: {error}"
                ));
                false
            }
        }
    }
}

fn log_source(path: &Path, source: &Source) {
    match source {
        Source::Absent => crate::diagnose::log(format!(
            "accounts db: not active at {}; using settings.json accounts",
            path.display()
        )),
        Source::Present(snapshot) => {
            let list = |profiles: &[AccountProfile]| {
                profiles
                    .iter()
                    .map(|profile| format!("{}={}", profile.id, profile.config_dir))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            crate::diagnose::log(format!(
                "accounts db: {} enabled Claude account(s) from {} schema={} revision={} profiles=[{}]",
                snapshot.profiles.len(),
                path.display(),
                snapshot.schema,
                snapshot.revision,
                list(&snapshot.profiles)
            ));
            crate::diagnose::log(match &snapshot.codex_profiles {
                Some(codex) => format!(
                    "accounts db: {} enabled Codex account(s) from the database profiles=[{}]",
                    codex.len(),
                    list(codex)
                ),
                None => format!(
                    "accounts db: schema {} < {CODEX_SCHEMA}; Codex keeps its settings.json accounts",
                    snapshot.schema
                ),
            });
        }
    }
}

static TRACKER: Mutex<Tracker> = Mutex::new(Tracker { current: None });

fn with_tracker<T>(f: impl FnOnce(&mut Tracker, &Path) -> T) -> T {
    let path = database_path();
    let mut tracker = TRACKER.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut tracker, &path)
}

/// The account settings the monitor should use: `settings.json` with the
/// Claude (and, from schema 2, Codex) profiles replaced by the database when
/// it is active.
pub fn effective(accounts: &AccountSettings) -> AccountSettings {
    let mut effective = accounts.clone();
    with_tracker(|tracker, path| apply(tracker.current(path), &mut effective));
    effective
}

/// Periodic revision check. Returns `true` when accounts must be reloaded.
pub fn check_for_changes() -> bool {
    with_tracker(|tracker, path| tracker.check(path))
}

/// The Account Manager's address for the "Manage accounts" menu item.
pub fn manager_url() -> String {
    with_tracker(|tracker, path| match tracker.current(path) {
        Source::Present(snapshot) => snapshot.manager_url.clone(),
        Source::Absent => DEFAULT_MANAGER_URL.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const SCHEMA: &str = "CREATE TABLE accounts (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config_dir TEXT NOT NULL,
          email TEXT, plan TEXT, enabled INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";

    struct TempDb(PathBuf);

    impl TempDb {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(std::env::temp_dir().join(format!(
                "ccum-accounts-db-{}-{unique}-{}.db",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )))
        }

        fn run(&self, sql: &str) {
            winsqlite::execute_script(&self.0, sql).unwrap();
        }

        fn contract(&self, revision: i64) {
            self.run(SCHEMA);
            self.run(&format!(
                "INSERT INTO meta VALUES ('schema', '1'), ('revision', '{revision}'),
                 ('manager_url', 'http://127.0.0.1:47291');"
            ));
        }

        fn account(&self, id: &str, name: &str, enabled: i64, sort_order: i64) {
            self.run(&format!(
                "INSERT INTO accounts (id, name, config_dir, enabled, sort_order, created_at, updated_at)
                 VALUES ('{id}', '{name}', 'C:\\Users\\me\\.claude-{id}', {enabled}, {sort_order},
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');"
            ));
        }

        /// What the web app does to an old database: add the column, bump the schema.
        fn upgrade_to_v2(&self) {
            self.run(
                "ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
                 UPDATE meta SET value = '2' WHERE key = 'schema';",
            );
        }

        fn codex_account(&self, id: &str, name: &str, enabled: i64, sort_order: i64) {
            self.run(&format!(
                "INSERT INTO accounts (id, name, config_dir, enabled, sort_order, provider, created_at, updated_at)
                 VALUES ('{id}', '{name}', 'C:\\Users\\me\\.codex-{id}', {enabled}, {sort_order}, 'codex',
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');"
            ));
        }

        fn bump(&self, revision: i64) {
            self.run(&format!(
                "UPDATE meta SET value = '{revision}' WHERE key = 'revision';"
            ));
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn settings_with_claude_and_codex() -> AccountSettings {
        let mut settings = AccountSettings::default();
        settings.claude.add();
        settings.claude.profiles[1].config_dir = "C:\\legacy-claude".into();
        settings.claude.profiles[1].enabled = true;
        settings.codex.add();
        settings.codex.profiles[1].config_dir = "C:\\codex-work".into();
        settings.codex.profiles[1].enabled = true;
        settings
    }

    fn profiles(source: &Source) -> Vec<(String, String, String)> {
        match source {
            Source::Absent => panic!("database should be active"),
            Source::Present(snapshot) => snapshot
                .profiles
                .iter()
                .map(|p| (p.id.clone(), p.name.clone(), p.config_dir.clone()))
                .collect(),
        }
    }

    #[test]
    fn environment_override_selects_the_database_path() {
        let default = crate::app_settings::app_data_directory().join("accounts.db");
        assert_eq!(database_path_from(None), default);
        assert_eq!(database_path_from(Some("".into())), default);
        assert_eq!(
            database_path_from(Some(r"C:\Temp\test accounts.db".into())),
            PathBuf::from(r"C:\Temp\test accounts.db")
        );
        // The override is honoured end to end by the loader.
        let db = TempDb::new();
        db.contract(7);
        db.account("ba", "ba", 1, 0);
        let path = database_path_from(Some(db.0.clone().into_os_string()));
        assert_eq!(read_revision(&path).unwrap(), Some(7));
    }

    #[test]
    fn missing_database_keeps_settings_accounts_unchanged() {
        let db = TempDb::new();
        assert_eq!(load(&db.0).unwrap(), Source::Absent);
        assert_eq!(read_revision(&db.0).unwrap(), None);
        assert!(
            !db.0.exists(),
            "a read-only check must never create the file"
        );
        let settings = settings_with_claude_and_codex();
        let mut applied = settings.clone();
        apply(&Source::Absent, &mut applied);
        assert_eq!(applied, settings);
    }

    #[test]
    fn database_without_schema_row_is_ignored() {
        let db = TempDb::new();
        db.run(SCHEMA);
        db.run("INSERT INTO meta VALUES ('revision', '3');");
        db.account("ba", "ba", 1, 0);
        assert_eq!(load(&db.0).unwrap(), Source::Absent);
        assert_eq!(read_revision(&db.0).unwrap(), None);

        let empty = TempDb::new();
        empty.run("CREATE TABLE unrelated (v TEXT);");
        assert_eq!(load(&empty.0).unwrap(), Source::Absent);
    }

    #[test]
    fn unreadable_database_falls_back_to_settings() {
        let db = TempDb::new();
        std::fs::write(&db.0, "not a sqlite database. ".repeat(64)).unwrap();
        assert!(load(&db.0).is_err());
        let mut tracker = Tracker::default();
        assert_eq!(tracker.current(&db.0), &Source::Absent);
    }

    #[test]
    fn enabled_rows_replace_only_claude_profiles_in_sort_order() {
        let db = TempDb::new();
        db.contract(4);
        db.account("zeta", "zeta", 1, 0);
        db.account("alpha", "alpha", 1, 0);
        db.account("first", "first", 1, -1);
        db.account("hidden", "hidden", 0, -5);
        db.account("last", "last", 1, 9);
        let source = load(&db.0).unwrap();
        assert_eq!(
            profiles(&source)
                .into_iter()
                .map(|(id, _, _)| id)
                .collect::<Vec<_>>(),
            ["first", "alpha", "zeta", "last"]
        );
        let Source::Present(snapshot) = &source else {
            unreachable!()
        };
        assert_eq!(snapshot.revision, 4);
        assert_eq!(snapshot.manager_url, "http://127.0.0.1:47291");
        assert!(snapshot
            .profiles
            .iter()
            .all(|p| p.enabled && p.credentials_path.is_empty()));
        assert_eq!(
            snapshot.profiles[0].config_dir,
            "C:\\Users\\me\\.claude-first"
        );

        let settings = settings_with_claude_and_codex();
        let mut applied = settings.clone();
        apply(&source, &mut applied);
        assert_eq!(applied.codex, settings.codex);
        assert_eq!(applied.claude.profiles, snapshot.profiles);
        assert_eq!(applied.claude.selected, "first");
        assert_eq!(applied.claude.selected().unwrap().id, "first");
        // Every DB profile resolves to its own credentials file, never ~/.claude.
        assert_eq!(
            applied.claude.profiles[1]
                .credential_path(crate::providers::ProviderId::Claude)
                .unwrap(),
            Some(PathBuf::from(
                "C:\\Users\\me\\.claude-alpha\\.credentials.json"
            ))
        );
    }

    #[test]
    fn zero_enabled_rows_mean_zero_claude_accounts() {
        let db = TempDb::new();
        db.contract(1);
        db.account("ba", "ba", 0, 0);
        db.account("kv", "kv", 0, 1);
        let source = load(&db.0).unwrap();
        assert!(profiles(&source).is_empty());
        let mut applied = settings_with_claude_and_codex();
        apply(&source, &mut applied);
        assert!(applied.claude.profiles.is_empty());
        assert!(applied.claude.selected().is_none());
        assert_eq!(applied.codex, settings_with_claude_and_codex().codex);
        // No invented "default" profile: select_accounts must drop Claude usage.
        let mut data = crate::models::AppUsageData::default();
        data.insert(
            crate::providers::ProviderId::Claude,
            crate::models::UsageData::default(),
        );
        data.select_accounts(&applied);
        assert!(data.get(crate::providers::ProviderId::Claude).is_none());
    }

    fn codex(source: &Source) -> Option<Vec<(String, String)>> {
        match source {
            Source::Absent => panic!("database should be active"),
            Source::Present(snapshot) => snapshot.codex_profiles.as_ref().map(|profiles| {
                profiles
                    .iter()
                    .map(|p| (p.id.clone(), p.config_dir.clone()))
                    .collect()
            }),
        }
    }

    fn ids(profiles: &[AccountProfile]) -> Vec<&str> {
        profiles.iter().map(|p| p.id.as_str()).collect()
    }

    #[test]
    fn schema_1_without_provider_column_is_all_claude_and_codex_keeps_settings() {
        let db = TempDb::new();
        db.contract(3);
        db.account("ba", "ba", 1, 0);
        db.account("kv", "kv", 1, 1);
        let source = load(&db.0).unwrap();
        let Source::Present(snapshot) = &source else {
            panic!("database should be active")
        };
        assert_eq!(snapshot.schema, 1);
        assert_eq!(ids(&snapshot.profiles), ["ba", "kv"]);
        assert_eq!(codex(&source), None);
        let settings = settings_with_claude_and_codex();
        let mut applied = settings.clone();
        apply(&source, &mut applied);
        assert_eq!(ids(&applied.claude.profiles), ["ba", "kv"]);
        assert_eq!(
            applied.codex, settings.codex,
            "schema 1: settings.json Codex"
        );
    }

    #[test]
    fn schema_1_with_a_provider_column_never_turns_codex_rows_into_claude() {
        let db = TempDb::new();
        db.contract(3);
        db.account("ba", "ba", 1, 0);
        db.run("ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';");
        db.codex_account("cx", "cx", 1, 0);
        let source = load(&db.0).unwrap();
        assert_eq!(
            profiles(&source)
                .into_iter()
                .map(|(id, _, _)| id)
                .collect::<Vec<_>>(),
            ["ba"]
        );
        assert_eq!(codex(&source), None);
        let settings = settings_with_claude_and_codex();
        let mut applied = settings.clone();
        apply(&source, &mut applied);
        assert_eq!(applied.codex, settings.codex);
    }

    #[test]
    fn schema_2_splits_mixed_rows_by_provider_in_sort_order() {
        let db = TempDb::new();
        db.contract(5);
        db.account("ba", "ba", 1, 2);
        db.upgrade_to_v2();
        db.account("kv", "kv", 1, 0);
        db.codex_account("cz", "zeta", 1, 1);
        db.codex_account("ca", "alpha", 1, 1);
        db.codex_account("c0", "first", 1, -3);
        db.codex_account("off", "off", 0, -9);
        db.account("hidden", "hidden", 0, -9);
        db.run(
            "INSERT INTO accounts (id, name, config_dir, enabled, sort_order, provider, created_at, updated_at)
             VALUES ('gm', 'gm', 'C:\\gm', 1, 0, 'gemini', 'x', 'x');",
        );
        let source = load(&db.0).unwrap();
        let Source::Present(snapshot) = &source else {
            panic!("database should be active")
        };
        assert_eq!(snapshot.schema, 2);
        assert_eq!(ids(&snapshot.profiles), ["kv", "ba"]);
        assert_eq!(
            codex(&source).unwrap(),
            [
                ("c0".to_string(), "C:\\Users\\me\\.codex-c0".to_string()),
                ("ca".to_string(), "C:\\Users\\me\\.codex-ca".to_string()),
                ("cz".to_string(), "C:\\Users\\me\\.codex-cz".to_string()),
            ],
            "enabled codex rows only, ordered by sort_order then name"
        );

        let mut applied = settings_with_claude_and_codex();
        apply(&source, &mut applied);
        assert_eq!(ids(&applied.claude.profiles), ["kv", "ba"]);
        assert_eq!(ids(&applied.codex.profiles), ["c0", "ca", "cz"]);
        assert_eq!(applied.codex.selected, "c0");
        assert!(applied.codex.profiles.iter().all(|p| p.enabled));
        // Each Codex profile reads auth.json in its own CODEX_HOME.
        assert_eq!(
            applied.codex.profiles[1]
                .credential_path(ProviderId::Codex)
                .unwrap(),
            Some(PathBuf::from("C:\\Users\\me\\.codex-ca\\auth.json"))
        );
    }

    #[test]
    fn schema_2_with_zero_enabled_codex_rows_means_zero_codex_accounts() {
        let db = TempDb::new();
        db.contract(1);
        db.upgrade_to_v2();
        db.account("ba", "ba", 1, 0);
        db.codex_account("cx", "cx", 0, 0);
        let source = load(&db.0).unwrap();
        assert_eq!(codex(&source), Some(Vec::new()));
        let mut applied = settings_with_claude_and_codex();
        apply(&source, &mut applied);
        assert!(applied.codex.profiles.is_empty());
        assert!(applied.codex.selected().is_none());
        // No invented "default" profile: select_accounts must drop Codex usage.
        let mut data = crate::models::AppUsageData::default();
        data.insert(ProviderId::Codex, crate::models::UsageData::default());
        data.select_accounts(&applied);
        assert!(data.get(ProviderId::Codex).is_none());
    }

    #[test]
    fn a_schema_upgrade_or_codex_change_reloads_both_providers() {
        let db = TempDb::new();
        db.contract(1);
        db.account("ba", "ba", 1, 0);
        let mut tracker = Tracker::default();
        assert_eq!(codex(tracker.current(&db.0)), None);

        // The web app upgrades the schema without bumping the revision.
        db.upgrade_to_v2();
        assert!(tracker.check(&db.0), "a schema change alone reloads");
        assert_eq!(codex(tracker.current(&db.0)), Some(Vec::new()));

        db.codex_account("cx", "cx", 1, 0);
        db.bump(2);
        assert!(tracker.check(&db.0));
        assert_eq!(
            codex(tracker.current(&db.0)).unwrap()[0].0,
            "cx",
            "a codex row added under a new revision is picked up"
        );
        assert_eq!(profiles(tracker.current(&db.0)).len(), 1);

        db.run("UPDATE accounts SET enabled = 0 WHERE provider = 'codex';");
        db.bump(3);
        assert!(tracker.check(&db.0));
        assert_eq!(codex(tracker.current(&db.0)), Some(Vec::new()));
        assert!(!tracker.check(&db.0));
    }

    #[test]
    fn invalid_manager_url_uses_the_default() {
        let db = TempDb::new();
        db.contract(1);
        db.run("UPDATE meta SET value = 'javascript:alert(1)' WHERE key = 'manager_url';");
        let Source::Present(snapshot) = load(&db.0).unwrap() else {
            panic!("database should be active")
        };
        assert_eq!(snapshot.manager_url, DEFAULT_MANAGER_URL);
    }

    #[test]
    fn revision_changes_are_detected_and_reloaded() {
        let db = TempDb::new();
        let mut tracker = Tracker::default();
        // Not there yet: settings.json accounts.
        assert_eq!(tracker.current(&db.0), &Source::Absent);
        assert!(!tracker.check(&db.0));

        // The web app creates the database: a change.
        db.contract(1);
        db.account("ba", "ba", 1, 0);
        assert!(tracker.check(&db.0));
        assert_eq!(profiles(tracker.current(&db.0)).len(), 1);
        assert!(!tracker.check(&db.0), "same revision must not reload");

        // Rows changed without a revision bump are not picked up (contract:
        // the web app bumps on every write).
        db.account("kv", "kv", 1, 1);
        assert!(!tracker.check(&db.0));
        assert_eq!(profiles(tracker.current(&db.0)).len(), 1);

        db.bump(2);
        assert!(tracker.check(&db.0));
        assert_eq!(read_revision(&db.0).unwrap(), Some(2));
        assert_eq!(
            profiles(tracker.current(&db.0))
                .into_iter()
                .map(|(id, _, _)| id)
                .collect::<Vec<_>>(),
            ["ba", "kv"]
        );

        db.run("UPDATE accounts SET enabled = 0;");
        db.bump(3);
        assert!(tracker.check(&db.0));
        assert!(profiles(tracker.current(&db.0)).is_empty());

        // The database disappears: back to settings.json.
        std::fs::remove_file(&db.0).unwrap();
        assert!(tracker.check(&db.0));
        assert_eq!(tracker.current(&db.0), &Source::Absent);
    }

    #[test]
    fn a_locked_database_keeps_the_previous_accounts_until_the_next_check() {
        let db = TempDb::new();
        db.contract(1);
        db.account("ba", "ba", 1, 0);
        let mut tracker = Tracker::default();
        let before = tracker.current(&db.0).clone();

        // Another process holds an exclusive write lock mid-transaction.
        let writer = winsqlite::WriterForTests::begin_exclusive(&db.0);
        writer.run("UPDATE meta SET value = '2' WHERE key = 'revision';");
        let started = std::time::Instant::now();
        assert!(!tracker.check(&db.0));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(tracker.current(&db.0), &before);
        writer.commit();

        assert!(tracker.check(&db.0));
        assert_eq!(tracker.current(&db.0).revision(), Some(2));
    }
}
