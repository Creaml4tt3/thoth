//! What the OCR module can install: the program for this target (`runtime.json`, compiled in) and the models (the
//! signed model list, or its compiled-in copy). Every URL is under `https://download.thothnotes.com/modules/`, every
//! file name is a plain name and every version a plain folder name, whatever list they come from.
use super::TARGET;
use crate::error::{HostError, HostResult};
use crate::updates::Version;
use serde::Deserialize;

pub const BASE: &str = "https://download.thothnotes.com/modules/";
/// Where the signed list is read (`models.json.sig` next to it).
pub const LIST_URL: &str = "https://download.thothnotes.com/modules/models.json";
const RUNTIME_JSON: &str = include_str!("runtime.json");
const MODELS_JSON: &str = include_str!("models.json");
/// The model list's minisign public key (Tauri's format: base64 of the `.pub` file's text).
const PUBLIC_KEY: &str = include_str!("modules.pub");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelId {
    Fast,
    Second,
}

impl ModelId {
    pub const ALL: [ModelId; 2] = [ModelId::Fast, ModelId::Second];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Second => "second",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.as_str() == text)
    }
}

/// One file to download: gzip at `url`, `size` and `sha256` of the `.gz`; saved as `name`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ModuleFile {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub targets: Option<Vec<String>>,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: ModelId,
    pub version: String,
    pub preset: String,
    pub min_app: String,
    pub protocol: u32,
    pub files: Vec<ModuleFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TestImage {
    pub file: ModuleFile,
    pub expect: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct List {
    pub serial: u64,
    pub models: Vec<ModelEntry>,
    pub test: TestImage,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Runtime {
    pub version: String,
    pub protocol: u32,
    pub onnxruntime: String,
    pub targets: std::collections::BTreeMap<String, Vec<ModuleFile>>,
}

#[derive(Clone, Debug)]
pub struct Catalog {
    pub runtime: Runtime,
    pub list: List,
}

impl Catalog {
    /// The app's own copy: `runtime.json` and the fallback list.
    pub fn compiled() -> Catalog {
        // Both are checked by tests (`the_compiled_list_is_good...`); a broken copy is a build that can't ship.
        let runtime = serde_json::from_str(RUNTIME_JSON).expect("runtime.json");
        Catalog { runtime, list: parse_list(MODELS_JSON.as_bytes()).expect("models.json") }
    }

    /// The signed list, checked with the compiled-in key: `serial` not below `last_serial` (the same list is read again
    /// after every restart; an older one is a rollback), every URL under `BASE`.
    pub fn from_signed(json: &[u8], sig: &str, last_serial: u64) -> HostResult<Catalog> {
        Self::from_signed_with(json, sig, last_serial, PUBLIC_KEY)
    }

    fn from_signed_with(json: &[u8], sig: &str, last_serial: u64, key: &str) -> HostResult<Catalog> {
        verify(json, sig, key)?;
        let list = parse_list(json)?;
        if list.serial < last_serial {
            return Err(HostError::not_allowed(format!("the model list's serial {} is below {last_serial}", list.serial)));
        }
        Ok(Catalog { runtime: Self::compiled().runtime, list })
    }

    /// The program files for this target; `None`: OCR isn't available in this build.
    pub fn runtime_files(&self) -> Option<&[ModuleFile]> {
        self.runtime.targets.get(TARGET).map(Vec::as_slice).filter(|f| !f.is_empty())
    }

    /// The newest entry for `id` this app can run: `minApp` <= `app` and the runtime's protocol.
    pub fn model(&self, id: ModelId, app: &Version) -> Option<&ModelEntry> {
        let runnable = |m: &&ModelEntry| m.id == id && m.protocol == self.runtime.protocol && Version::parse(&m.min_app).is_some_and(|min| min <= *app);
        // The list names a model once (its newest), but a list with several is read the same way: the last one wins.
        self.list.models.iter().rfind(runnable)
    }
}

/// Reads a list strictly: every URL under `BASE`, every name and version a plain file name.
pub fn parse_list(json: &[u8]) -> HostResult<List> {
    let list: List = serde_json::from_slice(json).map_err(|e| HostError::bad_argument(format!("the model list is not valid: {e}")))?;
    let files = list.models.iter().flat_map(|m| &m.files).chain(std::iter::once(&list.test.file));
    for f in files {
        check_file(f)?;
    }
    for m in &list.models {
        plain_name(&m.version)?;
    }
    Ok(list)
}

fn check_file(f: &ModuleFile) -> HostResult<()> {
    plain_name(&f.name)?;
    let url = url::Url::parse(&f.url).map_err(|_| HostError::not_allowed(format!("{} is not an address", f.url)))?;
    // The parsed form must be the text itself: no `..`, no escapes, no credentials, nothing the parser rewrote.
    if url.as_str() != f.url || !f.url.starts_with(BASE) {
        return Err(HostError::not_allowed(format!("{} is not under {BASE}", f.url)));
    }
    // A wrong sha256 or size needs no check here: the download fails on it.
    Ok(())
}

/// A file or folder name: no separators, no leading dot, no `..`, short.
pub fn plain_name(name: &str) -> HostResult<()> {
    let ok =
        !name.is_empty() && name.len() <= 100 && !name.starts_with('.') && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    if ok { Ok(()) } else { Err(HostError::bad_argument(format!("{name:?} is not a plain file name"))) }
}

/// The list's signature (Tauri's `.sig`: base64 of minisign's text) against `key` (base64 of the `.pub` file's text).
fn verify(json: &[u8], sig: &str, key: &str) -> HostResult<()> {
    use base64::Engine;
    let bad = || HostError::not_allowed("the model list's signature is not valid");
    let text = |b64: &str| base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok().and_then(|b| String::from_utf8(b).ok());
    let key = minisign_verify::PublicKey::decode(&text(key).ok_or_else(bad)?).map_err(|_| bad())?;
    let signature = minisign_verify::Signature::decode(&text(sig).ok_or_else(bad)?).map_err(|_| bad())?;
    key.verify(json, &signature, false).map_err(|_| bad())
}

/// The files of `files` meant for this target.
pub fn for_target(files: &[ModuleFile]) -> Vec<ModuleFile> {
    files.iter().filter(|f| f.targets.as_ref().is_none_or(|t| t.iter().any(|t| t == TARGET))).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &[u8] = include_bytes!("testdata/list.json");
    const LIST_SIG: &str = include_str!("testdata/list.json.sig");
    const FOREIGN: &[u8] = include_bytes!("testdata/foreign.json");
    const FOREIGN_SIG: &str = include_str!("testdata/foreign.json.sig");
    const TEST_KEY: &str = include_str!("testdata/test.pub");

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn reads_a_good_signed_list() {
        let c = Catalog::from_signed_with(LIST, LIST_SIG, 4, TEST_KEY).unwrap();
        assert_eq!(c.list.serial, 5);
    }

    #[test]
    fn refuses_a_bad_signature() {
        let tampered = String::from_utf8(LIST.to_vec()).unwrap().replace("\"Q4\"", "\"Q5\"");
        assert!(Catalog::from_signed_with(tampered.as_bytes(), LIST_SIG, 0, TEST_KEY).is_err());
        // The right list, but the app's own key did not sign it.
        assert!(Catalog::from_signed(LIST, LIST_SIG, 0).is_err());
        assert!(Catalog::from_signed_with(LIST, "not a signature", 0, TEST_KEY).is_err());
    }

    #[test]
    fn refuses_a_lower_serial_and_takes_the_same_list_again() {
        assert!(Catalog::from_signed_with(LIST, LIST_SIG, 9, TEST_KEY).is_err());
        assert!(Catalog::from_signed_with(LIST, LIST_SIG, 6, TEST_KEY).is_err());
        // After a restart the app reads the list it already accepted: the same serial, not a rollback.
        assert_eq!(Catalog::from_signed_with(LIST, LIST_SIG, 5, TEST_KEY).unwrap().list.serial, 5);
    }

    #[test]
    fn refuses_a_file_on_another_host() {
        let err = Catalog::from_signed_with(FOREIGN, FOREIGN_SIG, 0, TEST_KEY).unwrap_err();
        assert!(err.to_string().contains("download.example.com"), "{err}");
    }

    #[test]
    fn skips_a_model_for_a_newer_app() {
        let c = Catalog::from_signed_with(LIST, LIST_SIG, 0, TEST_KEY).unwrap();
        assert_eq!(c.model(ModelId::Fast, &v("0.12.0")).map(|m| m.version.as_str()), Some("f1"));
        assert_eq!(c.model(ModelId::Fast, &v("99.0.0")).map(|m| m.version.as_str()), Some("f2"));
        assert_eq!(c.model(ModelId::Fast, &v("0.11.0")), None);
        assert_eq!(c.model(ModelId::Second, &v("99.0.0")), None);
    }

    #[test]
    fn the_compiled_list_is_good_and_names_every_file_once_per_target() {
        let c = Catalog::compiled();
        for id in ModelId::ALL {
            let m = c.model(id, &v("0.12.0")).unwrap();
            for t in ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"] {
                let names: Vec<&str> =
                    m.files.iter().filter(|f| f.targets.as_ref().is_none_or(|ts| ts.iter().any(|x| x == t))).map(|f| f.name.as_str()).collect();
                let mut unique = names.clone();
                unique.sort();
                unique.dedup();
                assert_eq!(names.len(), unique.len(), "{id:?} on {t}: {names:?}");
                assert!(names.contains(&"det.onnx") && names.contains(&"rec.onnx"), "{id:?} on {t}");
            }
        }
        // runtime.json is the published ocr-v0.1.0: every target has its program, under BASE, with a hash.
        for t in ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"] {
            let files = &c.runtime.targets[t];
            assert!(files.iter().any(|f| f.name.starts_with("thoth-ocr") && f.executable), "{t}");
            for f in files {
                check_file(f).unwrap();
                assert!(f.size > 0 && f.sha256.len() == 64, "{t}: {}", f.name);
            }
        }
        assert!(c.runtime_files().is_some());
    }

    #[test]
    fn refuses_unsafe_names_and_versions_even_in_a_trusted_list() {
        let base = String::from_utf8(LIST.to_vec()).unwrap();
        for (from, to) in [("\"det.onnx\"", "\"../det.onnx\""), ("\"det.onnx\"", "\"a/b\""), ("\"f1\"", "\"..\""), ("\"f1\"", "\".hidden\"")] {
            let bad = base.replacen(from, to, 1);
            assert!(parse_list(bad.as_bytes()).is_err(), "{to}");
        }
    }
}
