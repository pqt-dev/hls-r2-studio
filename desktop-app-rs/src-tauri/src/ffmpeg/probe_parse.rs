//! Parsers for ffprobe output, mirroring probeDuration / probeFps / probeOutputInfo in PHP.
//! Port of desktop-app/src/main/ffmpeg/probeParse.ts.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

fn numeric() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();

    RE.get_or_init(|| {
        Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
            .expect("numeric pattern")
    })
}

fn float_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();

    RE.get_or_init(|| {
        Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
            .expect("float prefix pattern")
    })
}

/// PHP `floatval` (JS `parseFloat`): the leading numeric prefix, or 0.
fn floatval(value: &str) -> f64 {
    let parsed = float_prefix()
        .find(value.trim_start())
        .and_then(|m| m.as_str().parse::<f64>().ok());

    match parsed {
        Some(v) if v.is_finite() => v,
        _ => 0.0,
    }
}

/// Raw `format=duration` output -> seconds, or `None` when not numeric or <= 0.
pub fn parse_duration_output(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();

    if !numeric().is_match(trimmed) {
        return None;
    }

    trimmed
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v > 0.0)
}

/// Raw `r_frame_rate` output (`num/den` or a plain number) -> fps; 0 when unusable (like PHP).
pub fn parse_frame_rate_output(raw: &str) -> f64 {
    let rate = raw.trim();

    match rate.find('/') {
        Some(slash) => {
            let denominator = floatval(&rate[slash + 1..]);

            if denominator > 0.0 {
                floatval(&rate[..slash]) / denominator
            } else {
                0.0
            }
        }
        None => floatval(rate),
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct OutputInfo {
    pub width: Option<u64>,
    pub height: Option<u64>,
    /// Rounded to 2 decimals.
    pub fps: Option<f64>,
    /// Integer kbps.
    pub bitrate_kbps: Option<i64>,
    pub codec: Option<String>,
}

/// What callers use instead of [`parse_output_info`] when ffprobe itself failed.
pub const EMPTY_OUTPUT_INFO: OutputInfo = OutputInfo {
    width: None,
    height: None,
    fps: None,
    bitrate_kbps: None,
    codec: None,
};

fn round2(value: f64) -> f64 {
    ((value + f64::EPSILON) * 100.0).round() / 100.0
}

fn positive_int_or_none(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;

    (number.fract() == 0.0 && number > 0.0 && number <= 9_007_199_254_740_991.0)
        .then_some(number as u64)
}

pub struct ParseOutputInfoOptions {
    /// Size in bytes of the probed segment, used when ffprobe reports no bit_rate.
    pub segment_bytes: u64,
    pub segment_seconds: f64,
}

/// JS `Number(value)` for a string or number JSON value; NaN otherwise.
fn js_number_of(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();

            if t.is_empty() {
                0.0
            } else if numeric().is_match(t) {
                t.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
        _ => f64::NAN,
    }
}

/// Parses the `-of json` output of `probe_output_info_args`. Callers use [`EMPTY_OUTPUT_INFO`]
/// (instead of calling this) when ffprobe itself failed.
pub fn parse_output_info(raw_json: &str, options: &ParseOutputInfoOptions) -> OutputInfo {
    // PHP keeps going with an empty stream on invalid JSON; the bitrate fallback still applies.
    let data: Value = serde_json::from_str(raw_json).unwrap_or(Value::Null);
    let stream = data
        .get("streams")
        .and_then(Value::as_array)
        .and_then(|streams| streams.first())
        .filter(|first| first.is_object());
    let field = |name: &str| stream.and_then(|s| s.get(name));

    let mut fps = None;

    if let Some(frame_rate) = field("r_frame_rate").and_then(Value::as_str) {
        if frame_rate.contains('/') {
            let mut parts = frame_rate.split('/');
            let num = parts.next().unwrap_or("");
            let den = parts.next().unwrap_or("");
            let denominator = floatval(den);

            fps = (denominator > 0.0).then(|| round2(floatval(num) / denominator));
        }
    }

    let bit_rate = js_number_of(field("bit_rate"));
    let bitrate_kbps = if bit_rate.is_finite() && bit_rate > 0.0 {
        Some((bit_rate / 1000.0).round() as i64)
    } else if options.segment_seconds > 0.0 {
        Some(
            ((options.segment_bytes as f64 * 8.0) / 1000.0 / options.segment_seconds).round()
                as i64,
        )
    } else {
        None
    };

    OutputInfo {
        width: positive_int_or_none(field("width")),
        height: positive_int_or_none(field("height")),
        fps,
        bitrate_kbps,
        codec: field("codec_name")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_durations() {
        for (raw, expected) in [
            ("12.345000\n", 12.345),
            ("  7 ", 7.0),
            ("1e2", 100.0),
            (".5", 0.5),
        ] {
            assert_eq!(parse_duration_output(raw), Some(expected), "{raw:?}");
        }
    }

    #[test]
    fn rejects_unusable_durations() {
        for raw in ["N/A", "", "0", "0.000000", "-3", "abc", "1,5", "Infinity"] {
            assert_eq!(parse_duration_output(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn parses_frame_rates() {
        for (raw, expected) in [
            ("30000/1001\n", 30000.0 / 1001.0),
            ("25/1", 25.0),
            ("0/0", 0.0),
            ("30/0", 0.0),
            ("24", 24.0),
            ("", 0.0),
            ("N/A", 0.0),
        ] {
            let got = parse_frame_rate_output(raw);

            assert!((got - expected).abs() < 1e-10, "{raw:?} -> {got}");
        }
    }

    const OPTIONS: ParseOutputInfoOptions = ParseOutputInfoOptions {
        segment_bytes: 1_000_000,
        segment_seconds: 6.0,
    };

    #[test]
    fn reads_all_fields_and_rounds_fps_to_2_decimals_and_bitrate_to_integer_kbps() {
        let json = r#"{"streams":[{"codec_name":"h264","width":1280,"height":720,
            "r_frame_rate":"30000/1001","bit_rate":"2345678"}]}"#;

        assert_eq!(
            parse_output_info(json, &OPTIONS),
            OutputInfo {
                width: Some(1280),
                height: Some(720),
                fps: Some(29.97),
                bitrate_kbps: Some(2346),
                codec: Some("h264".into()),
            }
        );
    }

    #[test]
    fn falls_back_to_the_segment_size_when_bit_rate_is_missing_or_zero() {
        let json =
            r#"{"streams":[{"codec_name":"h264","width":2,"height":2,"r_frame_rate":"25/1"}]}"#;

        assert_eq!(
            parse_output_info(json, &OPTIONS).bitrate_kbps,
            Some(((1_000_000.0_f64 * 8.0) / 1000.0 / 6.0).round() as i64)
        );
        assert_eq!(
            parse_output_info(r#"{"streams":[{"bit_rate":"0"}]}"#, &OPTIONS).bitrate_kbps,
            Some(1333)
        );
    }

    #[test]
    fn accepts_a_numeric_bit_rate() {
        assert_eq!(
            parse_output_info(r#"{"streams":[{"bit_rate":128000}]}"#, &OPTIONS).bitrate_kbps,
            Some(128)
        );
    }

    #[test]
    fn has_no_fallback_bitrate_when_the_segment_length_is_unusable() {
        let options = ParseOutputInfoOptions {
            segment_bytes: 5,
            segment_seconds: 0.0,
        };

        assert_eq!(
            parse_output_info(r#"{"streams":[{}]}"#, &options).bitrate_kbps,
            None
        );
    }

    #[test]
    fn returns_no_fps_for_an_invalid_rate() {
        let info = parse_output_info(r#"{"streams":[{"r_frame_rate":"0/0"}]}"#, &OPTIONS);

        assert_eq!(info.fps, None);
    }

    #[test]
    fn survives_empty_streams_and_invalid_json_like_php() {
        let expected = OutputInfo {
            bitrate_kbps: Some(1333),
            ..EMPTY_OUTPUT_INFO
        };

        assert_eq!(parse_output_info(r#"{"streams":[]}"#, &OPTIONS), expected);
        assert_eq!(parse_output_info("not json", &OPTIONS), expected);
    }

    #[test]
    fn ignores_non_integer_sizes_and_empty_codecs() {
        let info = parse_output_info(
            r#"{"streams":[{"width":12.5,"height":0,"codec_name":""}]}"#,
            &OPTIONS,
        );

        assert_eq!((info.width, info.height, info.codec), (None, None, None));
    }
}
