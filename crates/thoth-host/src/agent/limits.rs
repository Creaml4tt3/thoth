//! Limits on one agent run that the webview asks for (ADR-0007, "Limits"). The webview is untrusted (ADR-0008), so the
//! host checks them itself and refuses a bad value instead of quietly clamping it: a time limit and a spending limit
//! that were asked for but not applied would be worse than an error the user can see.
//!
//! - Time limit: a whole number of milliseconds, at least one second and at most 24 hours. Absent means the default
//!   of 30 minutes. The Agent Hub offers 5, 15, 30 and 60 minutes; the larger bound leaves room for a long task a
//!   person set up on purpose, while a forged value cannot keep a process alive for days.
//! - Budget: see [`super::claude::MAX_BUDGET_USD`] (checked as part of the argument policy).
use crate::error::{HostError, HostResult};
use std::time::Duration;

/// Used when the webview names no time limit: 30 minutes.
pub const DEFAULT_TIMEOUT_MS: u64 = 30 * 60 * 1000;
/// The shortest time limit the host accepts: one second.
pub const MIN_TIMEOUT_MS: u64 = 1000;
/// The longest time limit the host accepts: 24 hours.
pub const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;

/// The run's time limit, or `BAD_ARGUMENT` when the value is outside `MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS`.
pub fn validate_timeout(timeout_ms: Option<u64>) -> HostResult<Duration> {
    let ms = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&ms) {
        return Err(HostError::bad_argument(format!("The time limit must be between {} second and {} hours", MIN_TIMEOUT_MS / 1000, MAX_TIMEOUT_MS / 3_600_000)));
    }
    Ok(Duration::from_millis(ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_means_thirty_minutes() {
        assert_eq!(validate_timeout(None).unwrap(), Duration::from_secs(30 * 60));
    }

    #[test]
    fn accepts_one_second_to_twenty_four_hours() {
        for ms in [1000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, MAX_TIMEOUT_MS] {
            assert_eq!(validate_timeout(Some(ms)).unwrap(), Duration::from_millis(ms), "{ms}");
        }
    }

    #[test]
    fn refuses_zero_too_short_and_too_long() {
        for ms in [0, 1, 999, MAX_TIMEOUT_MS + 1, 48 * 60 * 60 * 1000, u64::MAX] {
            assert_eq!(validate_timeout(Some(ms)).unwrap_err().code, "BAD_ARGUMENT", "{ms}");
        }
    }
}
