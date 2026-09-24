//! Minimal read-only wrapper around SQLite shipped with Windows 10 and 11.
//!
//! Keep this intentionally narrow: the monitor only reads small application-owned
//! databases (one text value, or a handful of rows). Linking as a raw DLL import
//! avoids bundling SQLite or depending on a Windows SDK import library at build time.

use std::ffi::{c_char, c_int, c_uchar, CStr, CString};
use std::fmt;
use std::path::Path;
use std::ptr;

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;
const SQLITE_OPEN_READ_ONLY: c_int = 0x0000_0001;
const SQLITE_NULL: c_int = 5;

#[repr(C)]
struct Sqlite3 {
    _private: [u8; 0],
}

#[repr(C)]
struct Sqlite3Stmt {
    _private: [u8; 0],
}

#[link(name = "winsqlite3", kind = "raw-dylib")]
unsafe extern "C" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        database: *mut *mut Sqlite3,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close(database: *mut Sqlite3) -> c_int;
    fn sqlite3_errmsg(database: *mut Sqlite3) -> *const c_char;
    fn sqlite3_busy_timeout(database: *mut Sqlite3, milliseconds: c_int) -> c_int;
    fn sqlite3_prepare_v2(
        database: *mut Sqlite3,
        sql: *const c_char,
        sql_bytes: c_int,
        statement: *mut *mut Sqlite3Stmt,
        tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_bind_text(
        statement: *mut Sqlite3Stmt,
        index: c_int,
        value: *const c_char,
        value_bytes: c_int,
        destructor: Option<unsafe extern "C" fn(*mut std::ffi::c_void)>,
    ) -> c_int;
    fn sqlite3_step(statement: *mut Sqlite3Stmt) -> c_int;
    fn sqlite3_column_text(statement: *mut Sqlite3Stmt, column: c_int) -> *const c_uchar;
    fn sqlite3_column_bytes(statement: *mut Sqlite3Stmt, column: c_int) -> c_int;
    fn sqlite3_column_int64(statement: *mut Sqlite3Stmt, column: c_int) -> i64;
    fn sqlite3_column_type(statement: *mut Sqlite3Stmt, column: c_int) -> c_int;
    fn sqlite3_finalize(statement: *mut Sqlite3Stmt) -> c_int;

    #[cfg(test)]
    fn sqlite3_exec(
        database: *mut Sqlite3,
        sql: *const c_char,
        callback: Option<
            unsafe extern "C" fn(
                *mut std::ffi::c_void,
                c_int,
                *mut *mut c_char,
                *mut *mut c_char,
            ) -> c_int,
        >,
        context: *mut std::ffi::c_void,
        error_message: *mut *mut c_char,
    ) -> c_int;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub(crate) struct Connection {
    raw: *mut Sqlite3,
}

impl Connection {
    fn open_read_only(path: &Path) -> Result<Self, Error> {
        Self::open_read_only_with_timeout(path, 1_000)
    }

    /// Open without write access. `busy_timeout_ms` bounds how long a read
    /// waits for another process's write transaction before failing with
    /// SQLITE_BUSY, so callers can retry later instead of blocking.
    pub(crate) fn open_read_only_with_timeout(
        path: &Path,
        busy_timeout_ms: u32,
    ) -> Result<Self, Error> {
        let filename = CString::new(path.as_os_str().as_encoded_bytes())
            .map_err(|_| Error("SQLite database path contains a NUL byte".into()))?;
        let mut raw = ptr::null_mut();
        let result = unsafe {
            sqlite3_open_v2(
                filename.as_ptr(),
                &mut raw,
                SQLITE_OPEN_READ_ONLY,
                ptr::null(),
            )
        };
        if result == SQLITE_OK && !raw.is_null() {
            let connection = Self { raw };
            let timeout = c_int::try_from(busy_timeout_ms).unwrap_or(c_int::MAX);
            let result = unsafe { sqlite3_busy_timeout(connection.raw, timeout) };
            if result != SQLITE_OK {
                return Err(error_message(
                    connection.raw,
                    "unable to set SQLite busy timeout",
                    result,
                ));
            }
            return Ok(connection);
        }

        let error = error_message(raw, "unable to open SQLite database", result);
        if !raw.is_null() {
            unsafe {
                let _ = sqlite3_close(raw);
            }
        }
        Err(error)
    }

    fn prepare(&self, sql: &str) -> Result<Statement<'_>, Error> {
        let sql =
            CString::new(sql).map_err(|_| Error("SQLite statement contains a NUL byte".into()))?;
        let mut raw = ptr::null_mut();
        let result =
            unsafe { sqlite3_prepare_v2(self.raw, sql.as_ptr(), -1, &mut raw, ptr::null_mut()) };
        if result != SQLITE_OK || raw.is_null() {
            return Err(error_message(
                self.raw,
                "unable to prepare SQLite statement",
                result,
            ));
        }
        Ok(Statement {
            raw,
            connection: self,
        })
    }

    /// Run a statement that returns no rows, such as `BEGIN` or `COMMIT`.
    pub(crate) fn execute(&self, sql: &str) -> Result<(), Error> {
        let statement = self.prepare(sql)?;
        match unsafe { sqlite3_step(statement.raw) } {
            SQLITE_DONE | SQLITE_ROW => Ok(()),
            result => Err(error_message(
                self.raw,
                "unable to execute SQLite statement",
                result,
            )),
        }
    }

    /// Run a parameterless query and hand every result row to `on_row`.
    pub(crate) fn query_rows(
        &self,
        sql: &str,
        mut on_row: impl FnMut(&Row<'_, '_>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let statement = self.prepare(sql)?;
        loop {
            match unsafe { sqlite3_step(statement.raw) } {
                SQLITE_DONE => return Ok(()),
                SQLITE_ROW => on_row(&Row {
                    statement: &statement,
                })?,
                result => return Err(error_message(self.raw, "unable to read SQLite row", result)),
            }
        }
    }
}

/// One result row, valid only inside a `query_rows` callback.
pub(crate) struct Row<'statement, 'connection> {
    statement: &'statement Statement<'connection>,
}

impl Row<'_, '_> {
    /// Text value of a column; `None` for SQL NULL.
    pub(crate) fn text(&self, column: c_int) -> Result<Option<String>, Error> {
        column_text(self.statement.raw, column)
    }

    /// Integer value of a column; `None` for SQL NULL. SQLite applies its
    /// usual numeric conversion to text values.
    pub(crate) fn integer(&self, column: c_int) -> Option<i64> {
        let raw = self.statement.raw;
        if unsafe { sqlite3_column_type(raw, column) } == SQLITE_NULL {
            None
        } else {
            Some(unsafe { sqlite3_column_int64(raw, column) })
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        unsafe {
            let _ = sqlite3_close(self.raw);
        }
    }
}

struct Statement<'connection> {
    raw: *mut Sqlite3Stmt,
    connection: &'connection Connection,
}

impl Statement<'_> {
    fn bind_text(&mut self, index: c_int, value: &CStr) -> Result<(), Error> {
        let value_bytes = c_int::try_from(value.to_bytes().len())
            .map_err(|_| Error("SQLite parameter is too large".into()))?;
        // SQLITE_STATIC is safe here because the caller keeps `value` alive
        // until after sqlite3_step returns.
        let result =
            unsafe { sqlite3_bind_text(self.raw, index, value.as_ptr(), value_bytes, None) };
        if result == SQLITE_OK {
            Ok(())
        } else {
            Err(error_message(
                self.connection.raw,
                "unable to bind SQLite parameter",
                result,
            ))
        }
    }

    fn optional_text(&mut self, column: c_int) -> Result<Option<String>, Error> {
        match unsafe { sqlite3_step(self.raw) } {
            SQLITE_DONE => Ok(None),
            SQLITE_ROW => column_text(self.raw, column),
            result => Err(error_message(
                self.connection.raw,
                "unable to read SQLite row",
                result,
            )),
        }
    }
}

impl Drop for Statement<'_> {
    fn drop(&mut self) {
        unsafe {
            let _ = sqlite3_finalize(self.raw);
        }
    }
}

fn column_text(statement: *mut Sqlite3Stmt, column: c_int) -> Result<Option<String>, Error> {
    let text = unsafe { sqlite3_column_text(statement, column) };
    if text.is_null() {
        return Ok(None);
    }
    let bytes = unsafe { sqlite3_column_bytes(statement, column) };
    let bytes = usize::try_from(bytes)
        .map_err(|_| Error("SQLite returned an invalid text length".into()))?;
    let value = unsafe { std::slice::from_raw_parts(text, bytes) };
    String::from_utf8(value.to_vec())
        .map(Some)
        .map_err(|_| Error("SQLite returned text that is not UTF-8".into()))
}

fn error_message(database: *mut Sqlite3, context: &str, result: c_int) -> Error {
    let detail = if database.is_null() {
        None
    } else {
        let message = unsafe { sqlite3_errmsg(database) };
        (!message.is_null()).then(|| unsafe { CStr::from_ptr(message) }.to_string_lossy())
    };
    match detail {
        Some(detail) => Error(format!("{context} ({result}): {detail}")),
        None => Error(format!("{context} ({result})")),
    }
}

/// Query column zero from the first row of a read-only, one-parameter query.
pub(crate) fn query_optional_text(
    path: &Path,
    sql: &str,
    parameter: &str,
) -> Result<Option<String>, Error> {
    let parameter = CString::new(parameter)
        .map_err(|_| Error("SQLite parameter contains a NUL byte".into()))?;
    let connection = Connection::open_read_only(path)?;
    let mut statement = connection.prepare(sql)?;
    statement.bind_text(1, &parameter)?;
    statement.optional_text(0)
}

/// Test-only: open (creating if needed) a writable database and run a script.
/// Used to build fixture databases for readers of this wrapper.
#[cfg(test)]
pub(crate) fn execute_script(path: &Path, sql: &str) -> Result<(), Error> {
    const SQLITE_OPEN_READ_WRITE: c_int = 0x0000_0002;
    const SQLITE_OPEN_CREATE: c_int = 0x0000_0004;
    let filename = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| Error("SQLite database path contains a NUL byte".into()))?;
    let sql = CString::new(sql).map_err(|_| Error("SQLite script contains a NUL byte".into()))?;
    let mut raw = ptr::null_mut();
    let result = unsafe {
        sqlite3_open_v2(
            filename.as_ptr(),
            &mut raw,
            SQLITE_OPEN_READ_WRITE | SQLITE_OPEN_CREATE,
            ptr::null(),
        )
    };
    if result != SQLITE_OK || raw.is_null() {
        let error = error_message(raw, "unable to create SQLite database", result);
        if !raw.is_null() {
            unsafe {
                let _ = sqlite3_close(raw);
            }
        }
        return Err(error);
    }
    let connection = Connection { raw };
    let result = unsafe {
        sqlite3_exec(
            connection.raw,
            sql.as_ptr(),
            None,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if result == SQLITE_OK {
        Ok(())
    } else {
        Err(error_message(
            connection.raw,
            "unable to run SQLite script",
            result,
        ))
    }
}

/// Test-only: a second process-like writer holding an exclusive lock, used to
/// prove readers fail fast instead of blocking while the web app writes.
#[cfg(test)]
pub(crate) struct WriterForTests(Connection);

#[cfg(test)]
impl WriterForTests {
    pub(crate) fn begin_exclusive(path: &Path) -> Self {
        const SQLITE_OPEN_READ_WRITE: c_int = 0x0000_0002;
        let filename = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        let mut raw = ptr::null_mut();
        let result = unsafe {
            sqlite3_open_v2(
                filename.as_ptr(),
                &mut raw,
                SQLITE_OPEN_READ_WRITE,
                ptr::null(),
            )
        };
        assert_eq!(result, SQLITE_OK);
        let writer = Self(Connection { raw });
        writer.run("BEGIN EXCLUSIVE");
        writer
    }

    pub(crate) fn run(&self, sql: &str) {
        let sql = CString::new(sql).unwrap();
        let result = unsafe {
            sqlite3_exec(
                self.0.raw,
                sql.as_ptr(),
                None,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        assert_eq!(result, SQLITE_OK);
    }

    pub(crate) fn commit(self) {
        self.run("COMMIT");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_database_path(tag: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "claude-code-usage-monitor-winsqlite-{tag}-{}-{unique}.db",
            std::process::id()
        ))
    }

    #[test]
    fn reads_an_optional_text_value_through_windows_sqlite() {
        let path = temp_database_path("text");
        execute_script(
            &path,
            "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);             INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'test-token');",
        )
        .unwrap();

        let query = "SELECT value FROM ItemTable WHERE key = ?1";
        assert_eq!(
            query_optional_text(&path, query, "cursorAuth/accessToken").unwrap(),
            Some("test-token".into())
        );
        assert_eq!(query_optional_text(&path, query, "missing").unwrap(), None);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reads_every_row_with_text_integer_and_null_columns() {
        let path = temp_database_path("rows");
        execute_script(
            &path,
            "CREATE TABLE t (name TEXT, n INTEGER);             INSERT INTO t VALUES ('a', 1), ('b', NULL), (NULL, 42), ('7', 3);",
        )
        .unwrap();
        let connection = Connection::open_read_only_with_timeout(&path, 50).unwrap();
        connection.execute("BEGIN").unwrap();
        let mut rows = Vec::new();
        connection
            .query_rows("SELECT name, n FROM t ORDER BY rowid", |row| {
                rows.push((row.text(0)?, row.integer(1)));
                Ok(())
            })
            .unwrap();
        connection.execute("COMMIT").unwrap();
        assert_eq!(
            rows,
            vec![
                (Some("a".into()), Some(1)),
                (Some("b".into()), None),
                (None, Some(42)),
                (Some("7".into()), Some(3)),
            ]
        );
        let mut count = 0;
        connection
            .query_rows(
                "SELECT CAST(name AS INTEGER) FROM t WHERE name = '7'",
                |row| {
                    assert_eq!(row.integer(0), Some(7));
                    count += 1;
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(count, 1);
        assert!(connection
            .query_rows("SELECT * FROM missing", |_| Ok(()))
            .is_err());
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn read_only_connections_cannot_write_or_create_files() {
        let path = temp_database_path("readonly");
        assert!(Connection::open_read_only_with_timeout(&path, 50).is_err());
        assert!(!path.exists());
        execute_script(&path, "CREATE TABLE t (v TEXT);").unwrap();
        let connection = Connection::open_read_only_with_timeout(&path, 50).unwrap();
        assert!(connection.execute("INSERT INTO t VALUES ('x')").is_err());
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }
}
