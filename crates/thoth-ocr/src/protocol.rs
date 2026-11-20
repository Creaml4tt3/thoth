//! The request half of protocol 1: one JSON header line, then exactly `len` bytes.

use serde::Deserialize;
use std::io::Read;

pub const MAX_IMAGE_BYTES: usize = 20_000_000;
pub const MAX_PDF_BYTES: usize = 50_000_000;
/// A header longer than this is not a header.
const MAX_HEADER: usize = 4096;

#[derive(Debug, PartialEq)]
pub enum Request {
    Image(Vec<u8>),
    Pdf { bytes: Vec<u8>, max_pages: usize },
}

#[derive(Debug, PartialEq)]
pub enum ProtoError {
    TooLarge,
    BadRequest(String),
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
enum Header {
    Image {
        len: usize,
    },
    Pdf {
        len: usize,
        #[serde(rename = "maxPages")]
        max_pages: usize,
    },
}

pub fn read_request(r: &mut impl Read) -> Result<Request, ProtoError> {
    let bad = |m: &str| ProtoError::BadRequest(m.to_string());
    // Byte by byte up to the newline, so nothing of the body is read into a buffer we would then have to split.
    let mut line = Vec::new();
    let mut b = [0u8; 1];
    loop {
        if r.read(&mut b).map_err(|e| bad(&e.to_string()))? == 0 {
            return Err(bad("no header line"));
        }
        if b[0] == b'\n' {
            break;
        }
        if line.len() == MAX_HEADER {
            return Err(bad("header too long"));
        }
        line.push(b[0]);
    }
    let header: Header = serde_json::from_slice(&line).map_err(|e| bad(&e.to_string()))?;
    let (len, limit) = match header {
        Header::Image { len } => (len, MAX_IMAGE_BYTES),
        Header::Pdf { len, .. } => (len, MAX_PDF_BYTES),
    };
    if len > limit {
        return Err(ProtoError::TooLarge);
    }
    let mut bytes = vec![0; len];
    r.read_exact(&mut bytes).map_err(|_| bad("the body is shorter than len"))?;
    Ok(match header {
        Header::Image { .. } => Request::Image(bytes),
        Header::Pdf { max_pages, .. } => Request::Pdf { bytes, max_pages },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(header: &str, body: &[u8]) -> Vec<u8> {
        let mut v = format!("{header}\n").into_bytes();
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn reads_an_image_request() {
        let bytes = req(r#"{"op":"image","len":3}"#, b"abc");
        assert_eq!(read_request(&mut bytes.as_slice()), Ok(Request::Image(b"abc".to_vec())));
        let bytes = req(r#"{"op":"pdf","len":2,"maxPages":5}"#, b"%P");
        assert_eq!(read_request(&mut bytes.as_slice()), Ok(Request::Pdf { bytes: b"%P".to_vec(), max_pages: 5 }));
    }

    #[test]
    fn refuses_a_length_over_the_limit_without_reading_it() {
        let bytes = req(r#"{"op":"pdf","len":60000000,"maxPages":5}"#, b"");
        assert_eq!(read_request(&mut bytes.as_slice()), Err(ProtoError::TooLarge));
        let bytes = req(r#"{"op":"image","len":20000001}"#, b"");
        assert_eq!(read_request(&mut bytes.as_slice()), Err(ProtoError::TooLarge));
    }

    #[test]
    fn refuses_a_short_body() {
        let bytes = req(r#"{"op":"image","len":10}"#, b"abcd");
        assert!(matches!(read_request(&mut bytes.as_slice()), Err(ProtoError::BadRequest(_))));
    }

    #[test]
    fn refuses_an_unknown_op() {
        let bytes = req(r#"{"op":"audio","len":1}"#, b"a");
        assert!(matches!(read_request(&mut bytes.as_slice()), Err(ProtoError::BadRequest(_))));
        let bytes = req("not json", b"");
        assert!(matches!(read_request(&mut bytes.as_slice()), Err(ProtoError::BadRequest(_))));
    }
}
