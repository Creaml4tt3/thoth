//! Which addresses a link preview may connect to (ADR-0020 rule 4): public unicast only. Checked on the address a
//! name resolved to, for every connection, so a page cannot point the host at the user's router, a service on this
//! computer or a cloud metadata endpoint, directly, by a redirect, or by a name that resolves to one.
use crate::error::{HostError, HostResult};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

/// The longest link the host fetches.
pub const MAX_URL: usize = 2048;

/// Is `ip` a public unicast address? Refused: unspecified, loopback, private (RFC 1918, IPv6 ULA), link-local,
/// CGNAT (100.64/10), multicast, broadcast, documentation, benchmarking and reserved ranges, IPv4-mapped and
/// IPv4-compatible IPv6 addresses (and NAT64 or 6to4 addresses) of any refused IPv4 address, and IPv6 outside
/// global unicast (2000::/3). `allow_loopback` is the test switch (ADR-0020): 127/8 and ::1 pass too.
pub fn is_public(ip: IpAddr, allow_loopback: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4, allow_loopback),
        IpAddr::V6(v6) => is_public_v6(v6, allow_loopback),
    }
}

fn is_public_v4(ip: Ipv4Addr, allow_loopback: bool) -> bool {
    let [a, b, c, _] = ip.octets();
    if a == 127 {
        return allow_loopback;
    }
    !(a == 0 // "this network", 0.0.0.0
        || a == 10
        || (a == 100 && (64..=127).contains(&b)) // CGNAT
        || (a == 169 && b == 254) // link-local
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 192 && b == 0 && c == 2) // TEST-NET-1
        || (a == 198 && b == 51 && c == 100) // TEST-NET-2
        || (a == 203 && b == 0 && c == 113) // TEST-NET-3
        || (a == 198 && (18..=19).contains(&b)) // benchmarking
        || (a == 192 && b == 88 && c == 99) // 6to4 relay anycast
        || a >= 224) // multicast, reserved, broadcast
}

fn is_public_v6(ip: Ipv6Addr, allow_loopback: bool) -> bool {
    if ip == Ipv6Addr::LOCALHOST {
        return allow_loopback;
    }
    let s = ip.segments();
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated): the IPv4 rules decide, loopback included.
    if s[..5] == [0, 0, 0, 0, 0] && (s[5] == 0xffff || s[5] == 0) {
        let v4 = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
        return s[5] == 0xffff && is_public_v4(v4, allow_loopback);
    }
    // NAT64 (64:ff9b::/96) carries an IPv4 address in its last 32 bits.
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_public_v4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8), false);
    }
    // 6to4 (2002::/16) carries one in bits 16..48.
    if s[0] == 0x2002 {
        return is_public_v4(Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8), false);
    }
    // Global unicast only, without Teredo (2001::/32), ORCHID and other IETF assignments (2001::/23) and documentation.
    (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && s[1] < 0x0200) && !(s[0] == 0x2001 && s[1] == 0x0db8) && s[0] != 0x3fff
}

/// A host name the host refuses before any lookup: `localhost` and anything under `.localhost` or `.local` (mDNS).
pub fn is_refused_name(name: &str) -> bool {
    let name = name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase();
    name == "localhost" || name.ends_with(".localhost") || name == "local" || name.ends_with(".local")
}

/// The origin of `url` for messages: never a path or a query, which could carry a secret.
pub fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// A link that may be fetched or opened: `http` or `https`, with a host, no user name or password, at most
/// `MAX_URL` long, no control characters. Returns the parsed URL. Addresses are checked later, when resolved.
pub fn web_link(input: &str) -> HostResult<Url> {
    if input.len() > MAX_URL {
        return Err(HostError::bad_argument("That link is too long"));
    }
    if input.chars().any(char::is_control) {
        return Err(HostError::bad_argument("That link has control characters"));
    }
    let url = Url::parse(input).map_err(|_| HostError::bad_argument("That is not a web address"))?;
    check_link(&url)?;
    Ok(url)
}

/// The rules of `web_link` for an already parsed URL (each redirect's target too).
pub fn check_link(url: &Url) -> HostResult<()> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(HostError::not_allowed("Only http and https links have previews"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(HostError::not_allowed("A link with a user name or password is not fetched"));
    }
    if url.as_str().len() > MAX_URL {
        return Err(HostError::not_allowed("That link is too long"));
    }
    match url.host() {
        None => Err(HostError::not_allowed("That link has no host")),
        Some(Host::Domain(name)) if is_refused_name(name) => Err(refused(url)),
        Some(_) => Ok(()),
    }
}

/// The error for an address that is not public. Names the origin only.
pub fn refused(url: &Url) -> HostError {
    HostError::not_allowed(format!("{} is not a public address", origin(url)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn refuses_every_non_public_class() {
        for (class, addr) in [
            ("unspecified v4", "0.0.0.0"),
            ("this network", "0.1.2.3"),
            ("loopback", "127.0.0.1"),
            ("loopback /8", "127.255.0.9"),
            ("private 10/8", "10.1.2.3"),
            ("private 172.16/12", "172.16.0.1"),
            ("private 172.31", "172.31.255.255"),
            ("private 192.168/16", "192.168.1.1"),
            ("link-local (cloud metadata)", "169.254.169.254"),
            ("CGNAT", "100.64.0.1"),
            ("CGNAT top", "100.127.255.255"),
            ("IETF assignments", "192.0.0.8"),
            ("documentation", "192.0.2.1"),
            ("documentation 2", "198.51.100.7"),
            ("documentation 3", "203.0.113.9"),
            ("benchmarking", "198.18.0.1"),
            ("multicast", "224.0.0.1"),
            ("multicast top", "239.255.255.250"),
            ("reserved", "240.0.0.1"),
            ("broadcast", "255.255.255.255"),
            ("unspecified v6", "::"),
            ("loopback v6", "::1"),
            ("ULA", "fc00::1"),
            ("ULA fd", "fd12:3456::1"),
            ("link-local v6", "fe80::1"),
            ("site-local v6", "fec0::1"),
            ("multicast v6", "ff02::1"),
            ("mapped loopback", "::ffff:127.0.0.1"),
            ("mapped private", "::ffff:10.0.0.1"),
            ("mapped metadata", "::ffff:169.254.169.254"),
            ("compatible", "::10.0.0.1"),
            ("compatible public", "::8.8.8.8"),
            ("NAT64 of private", "64:ff9b::a00:1"),
            ("6to4 of private", "2002:c0a8:0101::1"),
            ("Teredo", "2001:0:4136:e378::1"),
            ("documentation v6", "2001:db8::1"),
            ("documentation v6 3fff", "3fff::1"),
            ("discard", "100::1"),
        ] {
            assert!(!is_public(ip(addr), false), "{class}: {addr} must be refused");
        }
    }

    #[test]
    fn allows_public_unicast() {
        for addr in ["8.8.8.8", "1.1.1.1", "93.184.215.14", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "192.169.0.1", "223.255.255.254", "2606:4700::6810:85e5", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:0808:0808::1"] {
            assert!(is_public(ip(addr), false), "{addr} is public");
        }
    }

    #[test]
    fn the_test_switch_allows_loopback_and_nothing_else() {
        for addr in ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"] {
            assert!(is_public(ip(addr), true), "{addr}");
        }
        for addr in ["10.0.0.1", "192.168.0.1", "169.254.169.254", "0.0.0.0", "::", "fe80::1", "64:ff9b::7f00:1"] {
            assert!(!is_public(ip(addr), true), "{addr}");
        }
    }

    #[test]
    fn refuses_local_names_before_any_lookup() {
        for name in ["localhost", "LOCALHOST", "localhost.", "a.localhost", "printer.local", "printer.local.", "local"] {
            assert!(is_refused_name(name), "{name}");
        }
        for name in ["example.com", "localhost.example.com", "local.example", "locality.org"] {
            assert!(!is_refused_name(name), "{name}");
        }
    }

    #[test]
    fn checks_the_link_itself() {
        assert_eq!(web_link("https://example.com/a?b#c").unwrap().as_str(), "https://example.com/a?b#c");
        assert_eq!(web_link("http://example.com").unwrap().as_str(), "http://example.com/");
        for (bad, code) in [
            ("javascript:alert(1)", "NOT_ALLOWED"),
            ("data:text/html,<b>", "NOT_ALLOWED"),
            ("file:///etc/passwd", "NOT_ALLOWED"),
            ("ftp://example.com/", "NOT_ALLOWED"),
            ("mailto:a@b.example", "NOT_ALLOWED"),
            ("https://user:pw@example.com/", "NOT_ALLOWED"),
            ("https://user@example.com/", "NOT_ALLOWED"),
            ("http://localhost:8080/", "NOT_ALLOWED"),
            ("http://router.local/", "NOT_ALLOWED"),
            ("https://example.com/\n", "BAD_ARGUMENT"),
            ("not a url", "BAD_ARGUMENT"),
        ] {
            assert_eq!(web_link(bad).unwrap_err().code, code, "{bad:?}");
        }
        assert_eq!(web_link(&format!("https://example.com/{}", "a".repeat(MAX_URL))).unwrap_err().code, "BAD_ARGUMENT");
        // The URL parser turns other spellings of an IP address into the usual one, so the address rules see it.
        let odd = web_link("http://0x7f.1/").unwrap();
        assert_eq!(odd.host(), Some(Host::Ipv4(Ipv4Addr::LOCALHOST)));
        // Messages name the origin only.
        assert_eq!(refused(&web_link("http://10.0.0.1:81/secret?token=x").unwrap()).message, "http://10.0.0.1:81 is not a public address");
    }
}
