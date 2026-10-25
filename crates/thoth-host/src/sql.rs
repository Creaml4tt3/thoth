//! `SqlDriver` (packages/local-store/src/ports.ts) on one rusqlite connection
//! per open vault, at `<root>/.thoth/index.sqlite`, configured like
//! `NodeSqlDriver` (WAL, foreign keys, 5 s busy timeout).
//!
//! The webview may run arbitrary SQL, but only against this one database
//! (ADR-0008). The connection is hardened so SQL cannot reach other files:
//! `SQLITE_LIMIT_ATTACHED = 0` (which also stops `VACUUM INTO`, since it
//! attaches its output), an authorizer that denies ATTACH/DETACH,
//! `load_extension`/`fts3_tokenizer` and the pragmas that name files or loosen
//! safety, `SQLITE_DBCONFIG_DEFENSIVE`, untrusted schema, extension loading off,
//! `SQLITE_OPEN_NOFOLLOW`, and a per-call deadline.
//!
//! Binding matches `node:sqlite`: JS numbers bind as REAL, `$bigint` as
//! INTEGER, strings as TEXT, `$bytes` as BLOB.
use crate::error::{HostError, HostResult};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rusqlite::config::DbConfig;
use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Batch, Connection, ErrorCode, OpenFlags, Statement};
use serde_json::{Map, Number, Value, json};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Largest SQL text accepted (the index DDL is a few KiB).
pub const MAX_SQL_BYTES: usize = 4 * 1024 * 1024;
/// Most parameters accepted in one call.
pub const MAX_PARAMS: usize = 32_766;
/// Upper bound on one result set, so a runaway query cannot exhaust host memory.
pub const MAX_RESULT_BYTES: usize = 256 * 1024 * 1024;
/// One SQL call is interrupted after this long.
const CALL_DEADLINE: Duration = Duration::from_secs(120);
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Pragmas that name files or weaken safety guarantees; the rest only touch this index.
const DENIED_PRAGMAS: &[&str] = &[
    "temp_store_directory",
    "data_store_directory",
    "writable_schema",
    "trusted_schema",
    "journal_mode",
    "locking_mode",
    "mmap_size",
    "cell_size_check",
    "schema_version",
    "query_only",
];
const DENIED_FUNCTIONS: &[&str] = &["load_extension", "fts3_tokenizer"];
/// Virtual table modules SQL may create. The index schema needs only FTS5.
const ALLOWED_VTAB_MODULES: &[&str] = &["fts5", "fts5vocab"];

pub struct Sql {
    conn: Connection,
    /// Milliseconds since `epoch` after which the progress handler interrupts the statement.
    deadline: Arc<AtomicU64>,
    epoch: Instant,
}

impl Sql {
    pub fn open(path: &Path) -> HostResult<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let conn = Connection::open_with_flags(path, flags).map_err(sql_error)?;
        let sql = Self { conn, deadline: Arc::new(AtomicU64::new(u64::MAX)), epoch: Instant::now() };
        sql.harden()?;
        sql.conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;").map_err(sql_error)?;
        sql.conn.busy_timeout(Duration::from_millis(5000)).map_err(sql_error)?;
        // Installed after the pragmas above, so only the host itself can choose the journal mode.
        sql.conn.authorizer(Some(authorize));
        Ok(sql)
    }

    fn harden(&self) -> HostResult<()> {
        let c = &self.conn;
        c.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0).map_err(sql_error)?;
        c.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_BYTES as i32).map_err(sql_error)?;
        c.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true).map_err(sql_error)?;
        c.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false).map_err(sql_error)?;
        // SAFETY: valid open handle; this config takes (int, int*) and accepts a null out-pointer.
        let rc = unsafe { rusqlite::ffi::sqlite3_db_config(c.handle(), rusqlite::ffi::SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0 as std::ffi::c_int, std::ptr::null_mut::<std::ffi::c_int>()) };
        if rc != rusqlite::ffi::SQLITE_OK {
            return Err(HostError::internal("Could not disable SQLite extension loading"));
        }
        let deadline = self.deadline.clone();
        let epoch = self.epoch;
        c.progress_handler(10_000, Some(move || epoch.elapsed().as_millis() as u64 > deadline.load(Ordering::Relaxed)));
        Ok(())
    }

    fn arm(&self) -> Disarm<'_> {
        let limit = (self.epoch.elapsed() + CALL_DEADLINE).as_millis() as u64;
        self.deadline.store(limit, Ordering::Relaxed);
        Disarm(&self.deadline)
    }

    /// Runs every statement in `sql`, discarding rows (like `sqlite3_exec`).
    pub fn exec(&self, sql: &str) -> HostResult<()> {
        check_sql(sql)?;
        let _armed = self.arm();
        let mut batch = Batch::new(&self.conn, sql);
        while let Some(mut stmt) = batch.next().map_err(sql_error)? {
            drain(&mut stmt)?;
        }
        Ok(())
    }

    pub fn run(&self, sql: &str, params: &[Value]) -> HostResult<Value> {
        let _armed = self.arm();
        let mut stmt = self.prepare(sql, params)?;
        drain(&mut stmt)?;
        Ok(json!({ "changes": self.conn.changes() }))
    }

    pub fn all(&self, sql: &str, params: &[Value]) -> HostResult<Value> {
        let _armed = self.arm();
        let mut stmt = self.prepare(sql, params)?;
        let names = column_names(&stmt);
        let mut rows = stmt.raw_query();
        let mut out = Vec::new();
        let mut budget = MAX_RESULT_BYTES;
        while let Some(row) = rows.next().map_err(sql_error)? {
            out.push(row_object(row, &names, &mut budget)?);
        }
        Ok(Value::Array(out))
    }

    pub fn get(&self, sql: &str, params: &[Value]) -> HostResult<Value> {
        let _armed = self.arm();
        let mut stmt = self.prepare(sql, params)?;
        let names = column_names(&stmt);
        let mut rows = stmt.raw_query();
        let mut budget = MAX_RESULT_BYTES;
        match rows.next().map_err(sql_error)? {
            Some(row) => row_object(row, &names, &mut budget),
            None => Ok(Value::Null),
        }
    }

    fn prepare(&self, sql: &str, params: &[Value]) -> HostResult<rusqlite::CachedStatement<'_>> {
        check_sql(sql)?;
        if params.len() > MAX_PARAMS {
            return Err(HostError::bad_argument(format!("At most {MAX_PARAMS} parameters are accepted")));
        }
        let mut stmt = self.conn.prepare_cached(sql).map_err(sql_error)?;
        if params.len() > stmt.parameter_count() {
            return Err(HostError::new("SQLITE_ERROR", "column index out of range"));
        }
        for (i, param) in params.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, wire_to_sql(param)?).map_err(sql_error)?;
        }
        Ok(stmt)
    }
}

/// Resets the deadline when a call finishes.
struct Disarm<'a>(&'a AtomicU64);

impl Drop for Disarm<'_> {
    fn drop(&mut self) {
        self.0.store(u64::MAX, Ordering::Relaxed);
    }
}

fn check_sql(sql: &str) -> HostResult<()> {
    if sql.len() > MAX_SQL_BYTES {
        return Err(HostError::bad_argument(format!("SQL exceeds {MAX_SQL_BYTES} bytes")));
    }
    Ok(())
}

fn drain(stmt: &mut Statement<'_>) -> HostResult<()> {
    let mut rows = stmt.raw_query();
    while rows.next().map_err(sql_error)?.is_some() {}
    Ok(())
}

fn column_names(stmt: &Statement<'_>) -> Vec<String> {
    stmt.column_names().into_iter().map(str::to_owned).collect()
}

fn row_object(row: &rusqlite::Row<'_>, names: &[String], budget: &mut usize) -> HostResult<Value> {
    let mut obj = Map::with_capacity(names.len());
    for (i, name) in names.iter().enumerate() {
        let value = sql_to_wire(row.get_ref(i).map_err(sql_error)?)?;
        let cost = 16 + name.len() + match &value {
            Value::String(s) => s.len(),
            Value::Object(o) => o.values().map(|v| v.as_str().map_or(0, str::len)).sum(),
            _ => 8,
        };
        *budget = budget.checked_sub(cost).ok_or_else(|| HostError::bad_argument(format!("Result set exceeds {MAX_RESULT_BYTES} bytes")))?;
        obj.insert(name.clone(), value);
    }
    Ok(Value::Object(obj))
}

/// Decodes one `WireValue`.
pub fn wire_to_sql(value: &Value) -> HostResult<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Number(n) => SqlValue::Real(n.as_f64().ok_or_else(|| HostError::bad_argument("Invalid number parameter"))?),
        Value::Object(o) if o.len() == 1 => match (o.get("$bigint"), o.get("$bytes")) {
            (Some(Value::String(s)), None) => SqlValue::Integer(s.parse::<i64>().map_err(|_| HostError::bad_argument("$bigint is not a 64-bit integer"))?),
            (None, Some(Value::String(s))) => SqlValue::Blob(B64.decode(s).map_err(|_| HostError::bad_argument("$bytes is not valid base64"))?),
            _ => return Err(HostError::bad_argument("Unknown tagged SQL parameter")),
        },
        _ => return Err(HostError::bad_argument("Unsupported SQL parameter type")),
    })
}

/// Encodes one column value as a `WireValue`.
pub fn sql_to_wire(value: ValueRef<'_>) -> HostResult<Value> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) => Value::Number(i.into()),
        ValueRef::Integer(i) => json!({ "$bigint": i.to_string() }),
        ValueRef::Real(f) => Value::Number(Number::from_f64(f).ok_or_else(|| HostError::new("SQLITE_ERROR", "Non-finite REAL values cannot cross the wire"))?),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "$bytes": B64.encode(b) }),
    })
}

pub fn sql_error(error: rusqlite::Error) -> HostError {
    match &error {
        rusqlite::Error::SqliteFailure(e, message) => {
            let code = match e.code {
                ErrorCode::ConstraintViolation => "SQLITE_CONSTRAINT",
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => "SQLITE_BUSY",
                _ => "SQLITE_ERROR",
            };
            HostError::new(code, message.clone().unwrap_or_else(|| e.to_string()))
        }
        _ => HostError::new("SQLITE_ERROR", error.to_string()),
    }
}

fn authorize(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,
        // Reading these is harmless; assigning them is not.
        AuthAction::Pragma { pragma_name, pragma_value: Some(_) } if DENIED_PRAGMAS.iter().any(|p| p.eq_ignore_ascii_case(pragma_name)) => Authorization::Deny,
        // These name files even when read with an argument-less form, so deny them outright.
        AuthAction::Pragma { pragma_name, .. } if ["temp_store_directory", "data_store_directory"].iter().any(|p| p.eq_ignore_ascii_case(pragma_name)) => Authorization::Deny,
        AuthAction::Function { function_name } if DENIED_FUNCTIONS.iter().any(|f| f.eq_ignore_ascii_case(function_name)) => Authorization::Deny,
        AuthAction::CreateVtable { module_name, .. } if !ALLOWED_VTAB_MODULES.iter().any(|m| m.eq_ignore_ascii_case(module_name)) => Authorization::Deny,
        _ => Authorization::Allow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> (tempfile::TempDir, Sql) {
        let dir = tempfile::tempdir().unwrap();
        // Canonical: SQLITE_OPEN_NOFOLLOW refuses symlinked ancestors such as macOS's /var -> /private/var.
        let sql = Sql::open(&std::fs::canonicalize(dir.path()).unwrap().join("index.sqlite")).unwrap();
        (dir, sql)
    }

    #[test]
    fn fts5_unicode61_and_trigram_work() {
        let (_d, sql) = open();
        sql.exec("CREATE VIRTUAL TABLE a USING fts5(body, tokenize = 'unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE b USING fts5(body, tokenize = 'trigram');").unwrap();
        sql.run("INSERT INTO a(body) VALUES (?)", &[json!("Crème brûlée")]).unwrap();
        sql.run("INSERT INTO b(body) VALUES (?)", &[json!("ประชุมเรื่องสถาปัตยกรรมระบบ")]).unwrap();
        assert_eq!(sql.all("SELECT body FROM a WHERE a MATCH 'creme'", &[]).unwrap().as_array().unwrap().len(), 1);
        assert_eq!(sql.all("SELECT body FROM b WHERE b MATCH '\"สถาปัตย\"'", &[]).unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn attach_vacuum_into_and_extensions_are_refused() {
        let (dir, sql) = open();
        let other = dir.path().join("other.sqlite");
        let attach = format!("ATTACH DATABASE '{}' AS o", other.display());
        assert!(sql.exec(&attach).is_err());
        assert!(sql.exec(&format!("VACUUM INTO '{}'", dir.path().join("copy.sqlite").display())).is_err());
        assert!(!dir.path().join("copy.sqlite").exists());
        assert!(sql.get("SELECT load_extension('/tmp/x')", &[]).is_err());
        assert!(sql.exec("PRAGMA journal_mode = DELETE").is_err());
        assert!(sql.exec("PRAGMA writable_schema = 1").is_err());
        assert!(sql.exec("PRAGMA temp_store_directory = '/tmp'").is_err());
        assert_eq!(sql.get("PRAGMA journal_mode", &[]).unwrap(), json!({ "journal_mode": "wal" }));
        assert!(sql.exec("CREATE VIRTUAL TABLE r USING rtree(id, a, b)").is_err());
        assert_eq!(sql.conn.limit(Limit::SQLITE_LIMIT_ATTACHED).unwrap(), 0);
    }

    /// SQLite's NOFOLLOW is Unix-only; on Windows the host checks the files first (`VaultFs::refuse_linked_index`).
    #[test]
    #[cfg(unix)]
    fn symlinked_database_path_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        std::os::unix::fs::symlink(real.join("real.sqlite"), real.join("link.sqlite")).unwrap();
        assert!(Sql::open(&real.join("link.sqlite")).is_err());
    }

    #[test]
    fn wire_values_round_trip() {
        let (_d, sql) = open();
        let row = sql.get("SELECT ? AS n, ? AS big, ? AS b, ? AS t, 9007199254740993 AS unsafe", &[json!(1.5), json!({ "$bigint": "-9223372036854775808" }), json!({ "$bytes": "AP8=" }), json!("x")]).unwrap();
        assert_eq!(row, json!({ "n": 1.5, "big": { "$bigint": "-9223372036854775808" }, "b": { "$bytes": "AP8=" }, "t": "x", "unsafe": { "$bigint": "9007199254740993" } }));
    }
}
