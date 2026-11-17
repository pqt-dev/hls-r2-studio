//! The little XML the R2 client reads and writes: `ListBucketResult` (ListObjectsV2),
//! `DeleteResult`, the `<Error>` body of a failed call, and the `DeleteObjects` request body.
//!
//! A small strict scanner instead of an XML crate: the S3 answers are flat and well known, and
//! only element text is needed (with the predefined entities, character references and CDATA).

use crate::pipeline::deps::{ListPage, ListedObject};

/// Inner text of every `<name>...</name>` element (also `<name attr="...">`; `<name/>` is
/// empty), in document order. Elements of the same name must not nest (true for S3).
fn elements<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut found = Vec::new();
    let mut rest = xml;

    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(next) = after.chars().next() else {
            break;
        };

        if !(next == '>' || next == '/' || next.is_whitespace()) {
            // `<Keys>` when looking for `<Key>`: not this element.
            rest = after;
            continue;
        }

        let Some(tag_end) = after.find('>') else {
            break;
        };

        if after[..tag_end].ends_with('/') {
            found.push("");
            rest = &after[tag_end + 1..];
            continue;
        }

        let body = &after[tag_end + 1..];
        let Some(end) = body.find(&close) else {
            break;
        };

        found.push(&body[..end]);
        rest = &body[end + close.len()..];
    }

    found
}

fn first(xml: &str, name: &str) -> Option<String> {
    elements(xml, name).first().map(|text| text_of(text))
}

/// Element text: CDATA sections taken literally, entities and character references decoded.
pub fn text_of(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;

    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("<![CDATA[") {
            let end = after.find("]]>").unwrap_or(after.len());

            out.push_str(&after[..end]);
            rest = after.get(end + 3..).unwrap_or("");
        } else if rest.starts_with('&') {
            let end = rest.find(';').filter(|e| *e <= 12);
            let decoded = end.and_then(|e| decode_entity(&rest[1..e]));

            match (end, decoded) {
                (Some(e), Some(c)) => {
                    out.push(c);
                    rest = &rest[e + 1..];
                }
                _ => {
                    out.push('&');
                    rest = &rest[1..];
                }
            }
        } else {
            let next = match rest.find(['&', '<']) {
                // A lone `<` (not CDATA): keep it and move on.
                Some(0) => 1,
                Some(index) => index,
                None => rest.len(),
            };

            out.push_str(&rest[..next]);
            rest = &rest[next..];
        }
    }

    out
}

fn decode_entity(name: &str) -> Option<char> {
    match name {
        "lt" => Some('<'),
        "gt" => Some('>'),
        "amp" => Some('&'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => {
            let number = name.strip_prefix('#')?;
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse().ok()?,
            };

            char::from_u32(code)
        }
    }
}

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());

    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }

    out
}

/// A `ListObjectsV2` answer. `None` when it is not a `ListBucketResult`.
pub fn parse_list(xml: &str) -> Option<ListPage> {
    elements(xml, "ListBucketResult").first()?;

    let objects = elements(xml, "Contents")
        .into_iter()
        .filter_map(|block| {
            Some(ListedObject {
                key: first(block, "Key")?,
                size: first(block, "Size").and_then(|s| s.trim().parse().ok()),
            })
        })
        .collect();
    let truncated = first(xml, "IsTruncated").is_some_and(|t| t.trim() == "true");
    let next_token = if truncated {
        first(xml, "NextContinuationToken").filter(|t| !t.is_empty())
    } else {
        None
    };

    Some(ListPage {
        objects,
        next_token,
    })
}

/// Number of `<Error>` entries of a `DeleteResult` (keys that could not be deleted).
pub fn delete_failures(xml: &str) -> usize {
    elements(xml, "Error").len()
}

/// The S3 error `<Code>` of a failed call's body, if any.
pub fn error_code(xml: &str) -> Option<String> {
    let block = elements(xml, "Error").into_iter().next()?;

    first(block, "Code").filter(|c| !c.trim().is_empty())
}

/// `DeleteObjects` body (quiet mode: the answer only lists failures).
pub fn delete_body(keys: &[String]) -> String {
    let mut body = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
         <Delete xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
    );

    for key in keys {
        body.push_str("<Object><Key>");
        body.push_str(&escape(key));
        body.push_str("</Key></Object>");
    }

    body.push_str("<Quiet>true</Quiet></Delete>");
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>p/</Prefix>
<KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>true</IsTruncated>
<Contents><Key>p/a&amp;b.ts</Key><LastModified>x</LastModified><Size>10</Size></Contents>
<Contents><Key><![CDATA[p/<c>.ts]]></Key><Size>7</Size></Contents>
<NextContinuationToken>tok/+=</NextContinuationToken></ListBucketResult>"#;

    #[test]
    fn parses_a_list_page() {
        let page = parse_list(LIST).unwrap();

        assert_eq!(
            page.objects,
            vec![
                ListedObject {
                    key: "p/a&b.ts".into(),
                    size: Some(10)
                },
                ListedObject {
                    key: "p/<c>.ts".into(),
                    size: Some(7)
                },
            ]
        );
        assert_eq!(page.next_token.as_deref(), Some("tok/+="));
    }

    #[test]
    fn a_complete_listing_has_no_token_and_an_empty_one_no_objects() {
        let page = parse_list(
            "<ListBucketResult><IsTruncated>false</IsTruncated>\
             <NextContinuationToken>x</NextContinuationToken></ListBucketResult>",
        )
        .unwrap();

        assert_eq!(page, ListPage::default());
        assert!(parse_list("<Error><Code>AccessDenied</Code></Error>").is_none());
        assert!(parse_list("garbage").is_none());
    }

    #[test]
    fn reads_error_codes_and_delete_failures() {
        assert_eq!(
            error_code(
                "<?xml version=\"1.0\"?><Error><Code>SlowDown</Code><Message>m</Message></Error>"
            )
            .as_deref(),
            Some("SlowDown")
        );
        assert_eq!(error_code("<Error><Message>m</Message></Error>"), None);
        assert_eq!(error_code(""), None);
        assert_eq!(
            delete_failures(
                "<DeleteResult><Deleted><Key>a</Key></Deleted><Error><Key>b</Key><Code>AccessDenied</Code></Error>\
                 <Error><Key>c</Key></Error></DeleteResult>"
            ),
            2
        );
        assert_eq!(delete_failures("<DeleteResult></DeleteResult>"), 0);
        assert_eq!(delete_failures("<DeleteResult/>"), 0);
    }

    #[test]
    fn does_not_confuse_similar_element_names() {
        assert_eq!(elements("<Keys>x</Keys><Key>y</Key>", "Key"), vec!["y"]);
        assert_eq!(elements("<Key/><Key a=\"1\">z</Key>", "Key"), vec!["", "z"]);
        assert!(elements("<Key>unterminated", "Key").is_empty());
    }

    #[test]
    fn decodes_entities_and_keeps_unknown_ones() {
        assert_eq!(text_of("a&lt;b&gt;&quot;&apos;&#65;&#x42;"), "a<b>\"'AB");
        assert_eq!(text_of("&bogus; & x"), "&bogus; & x");
        assert_eq!(text_of("Tiếng Việt"), "Tiếng Việt");
    }

    #[test]
    fn builds_an_escaped_quiet_delete_body() {
        let body = delete_body(&["p/a.ts".into(), "p/<&>.jpg".into()]);

        assert!(body.starts_with("<?xml"));
        assert!(body.contains("<Object><Key>p/a.ts</Key></Object>"));
        assert!(body.contains("<Key>p/&lt;&amp;&gt;.jpg</Key>"));
        assert!(body.ends_with("<Quiet>true</Quiet></Delete>"));
        assert_eq!(elements(&body, "Key").len(), 2);
    }
}
