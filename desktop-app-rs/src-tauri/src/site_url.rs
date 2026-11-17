//! Site URL rules: https only, normalized to an origin, no credentials.
//! Shared by build.rs (via `#[path]`) and the app, so keep it dependency-free.

/// Returns the origin (`https://host[:port]`) of `raw`. Any path, query and fragment are dropped.
pub fn normalize(raw: &str) -> Result<String, String> {
    let text = raw.trim();

    if text.is_empty() {
        return Err("Enter the site URL.".to_string());
    }

    if text.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The site URL is not valid.".to_string());
    }

    let Some(scheme_end) = text.find("://") else {
        return Err("The site URL is not valid.".to_string());
    };

    if !text[..scheme_end].eq_ignore_ascii_case("https") {
        return Err("The site URL must start with https://.".to_string());
    }

    let rest = &text[scheme_end + 3..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");

    if authority.contains('@') {
        return Err("The site URL must not contain a user name or password.".to_string());
    }

    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };

    if host.is_empty() || host.starts_with('.') || host.contains(['[', ']']) {
        return Err("The site URL is not valid.".to_string());
    }

    let host = host.to_ascii_lowercase();

    match port {
        None => Ok(format!("https://{host}")),
        Some(port) => {
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return Err("The site URL is not valid.".to_string());
            }

            // Like `URL.origin`: the default port is dropped, so `https://h:443` is `https://h`.
            match port.trim_start_matches('0').parse::<u32>() {
                Ok(443) => Ok(format!("https://{host}")),
                Ok(number) if number <= 65535 => Ok(format!("https://{host}:{number}")),
                Ok(_) => Err("The site URL is not valid.".to_string()),
                // All zeros (port 0) parses from an empty string.
                Err(_) if port.bytes().all(|b| b == b'0') => Ok(format!("https://{host}:0")),
                Err(_) => Err("The site URL is not valid.".to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn keeps_only_the_origin() {
        assert_eq!(
            normalize(" https://Admin.Example.com:8443/path?q=1#x ").unwrap(),
            "https://admin.example.com:8443"
        );
    }

    #[test]
    fn lowercases_the_host() {
        assert_eq!(
            normalize("https://ADMIN.Example.COM").unwrap(),
            "https://admin.example.com"
        );
    }

    #[test]
    fn drops_the_default_port_443() {
        assert_eq!(normalize("https://host:443").unwrap(), "https://host");
        assert_eq!(normalize("https://host:443/").unwrap(), "https://host");
        assert_eq!(normalize("https://host:0443").unwrap(), "https://host");
        assert_eq!(
            normalize("https://HOST:443").unwrap(),
            normalize("https://host").unwrap()
        );
    }

    #[test]
    fn keeps_a_non_default_port() {
        assert_eq!(normalize("https://host:8443").unwrap(), "https://host:8443");
        assert_eq!(normalize("https://host:80").unwrap(), "https://host:80");
        assert!(normalize("https://host:65536").is_err());
    }

    #[test]
    fn strips_trailing_slash_path_query_and_fragment() {
        for raw in [
            "https://host/",
            "https://host/a/b",
            "https://host?x=1",
            "https://host#f",
        ] {
            assert_eq!(normalize(raw).unwrap(), "https://host", "{raw}");
        }
    }

    #[test]
    fn rejects_http_and_other_schemes() {
        assert!(normalize("http://host").is_err());
        assert!(normalize("HTTP://host:443").is_err());
        assert!(normalize("ftp://host").is_err());
    }

    #[test]
    fn rejects_bad_values() {
        assert!(normalize("").is_err());
        assert!(normalize("http://example.com").is_err());
        assert!(normalize("example.com").is_err());
        assert!(normalize("https://user:pw@example.com").is_err());
        assert!(normalize("https://").is_err());
        assert!(normalize("https://example.com:abc").is_err());
        assert!(normalize("https://exa mple.com").is_err());
    }
}
