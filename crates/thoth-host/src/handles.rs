//! Opaque handles: a kind prefix plus 128 random bits, so they are unguessable
//! and a handle of one kind can never be looked up as another.
use crate::error::{HostError, HostResult};

pub fn new_handle(kind: &str) -> HostResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| HostError::internal(format!("No randomness for handles: {e}")))?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{kind}_{hex}"))
}
