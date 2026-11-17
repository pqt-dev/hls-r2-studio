//! Incremental parser for the `-progress pipe:1` stream (`key=value` lines, blocks ended by a
//! `progress=continue|end` line). Chunks may split lines and keys anywhere. Port of
//! desktop-app/src/main/ffmpeg/progress.ts.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProgressUpdate {
    /// Latest out_time (seconds) found in the completed lines of this feed, or `None`.
    pub out_time_seconds: Option<f64>,
    /// True once `progress=end` has been seen (sticky).
    pub ended: bool,
}

#[derive(Debug, Default)]
pub struct ProgressParser {
    buffer: String,
    ended: bool,
    /// `out_time_ms` (really microseconds) is only a fallback when the same block has no
    /// `out_time_us`.
    block_has_us: bool,
}

/// `^<key>=(\d+)$` -> the digits as seconds * 1e6.
fn parse_micros(line: &str, key: &str) -> Option<f64> {
    let digits = line.strip_prefix(key)?.strip_prefix('=')?;

    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }

    digits.parse::<f64>().ok()
}

impl ProgressParser {
    pub fn new() -> Self {
        Self::default()
    }

    fn process_line(&mut self, line: &str, latest: &mut Option<f64>) {
        if let Some(us) = parse_micros(line, "out_time_us") {
            self.block_has_us = true;
            *latest = Some(us / 1e6);

            return;
        }

        if let Some(ms) = parse_micros(line, "out_time_ms") {
            if !self.block_has_us {
                *latest = Some(ms / 1e6);
            }

            return;
        }

        if line.starts_with("progress=") {
            self.block_has_us = false;

            if line == "progress=end" {
                self.ended = true;
            }
        }
    }

    fn drain(&mut self, lines: &[String]) -> ProgressUpdate {
        let mut latest = None;

        for line in lines {
            self.process_line(line.trim(), &mut latest);
        }

        ProgressUpdate {
            out_time_seconds: latest,
            ended: self.ended,
        }
    }

    pub fn feed(&mut self, chunk: &str) -> ProgressUpdate {
        self.buffer.push_str(chunk);

        let mut parts: Vec<String> = self.buffer.split('\n').map(str::to_string).collect();
        self.buffer = parts.pop().unwrap_or_default();

        self.drain(&parts)
    }

    /// Processes a trailing line that had no newline (call when the stream closes).
    pub fn flush(&mut self) -> ProgressUpdate {
        let rest = std::mem::take(&mut self.buffer);

        if rest.is_empty() {
            self.drain(&[])
        } else {
            self.drain(&[rest])
        }
    }
}

/// Fraction of the transcode done, clamped to [0, 1] and never below `previous`.
/// `None` when the duration is unknown (`None` or <= 0).
pub fn to_fraction(out_time_seconds: f64, duration: Option<f64>, previous: f64) -> Option<f64> {
    let duration = duration.filter(|d| *d > 0.0)?;
    let raw = if out_time_seconds.is_finite() {
        out_time_seconds / duration
    } else {
        0.0
    };

    Some(previous.max(raw.clamp(0.0, 1.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK_1: &str = "frame=10\nfps=0.0\nout_time_us=1500000\nout_time_ms=1500000\nout_time=00:00:01.500000\nprogress=continue\n";
    const BLOCK_2: &str = "out_time_us=3000000\nout_time_ms=3000000\nprogress=continue\n";
    const END: &str = "out_time_us=9000000\nprogress=end\n";

    #[test]
    fn parses_a_whole_block() {
        let mut parser = ProgressParser::new();

        assert_eq!(
            parser.feed(BLOCK_1),
            ProgressUpdate {
                out_time_seconds: Some(1.5),
                ended: false
            }
        );
    }

    #[test]
    fn returns_the_latest_value_when_a_chunk_holds_several_blocks() {
        let mut parser = ProgressParser::new();

        assert_eq!(
            parser.feed(&format!("{BLOCK_1}{BLOCK_2}")).out_time_seconds,
            Some(3.0)
        );
    }

    #[test]
    fn buffers_lines_and_keys_split_across_chunks_at_every_boundary() {
        let stream = format!("{BLOCK_1}{BLOCK_2}{END}");

        for cut in 1..stream.len() {
            let mut parser = ProgressParser::new();
            let first = parser.feed(&stream[..cut]);
            let second = parser.feed(&stream[cut..]);
            let latest = second.out_time_seconds.or(first.out_time_seconds);

            assert_eq!(latest, Some(9.0), "cut {cut}");
            assert!(second.ended, "cut {cut}");
        }
    }

    #[test]
    fn does_not_emit_a_value_from_an_unfinished_line() {
        let mut parser = ProgressParser::new();

        assert_eq!(parser.feed("out_time_us=12").out_time_seconds, None);
        assert_eq!(parser.feed("00000\n").out_time_seconds, Some(1.2));
    }

    #[test]
    fn works_one_character_at_a_time() {
        let mut parser = ProgressParser::new();
        let mut latest = None;
        let mut ended = false;

        for ch in format!("{BLOCK_1}{END}").chars() {
            let update = parser.feed(&ch.to_string());

            latest = update.out_time_seconds.or(latest);
            ended = update.ended;
        }

        assert_eq!(latest, Some(9.0));
        assert!(ended);
    }

    #[test]
    fn falls_back_to_out_time_ms_when_out_time_us_is_absent() {
        let mut parser = ProgressParser::new();

        assert_eq!(
            parser
                .feed("out_time_ms=2500000\nprogress=continue\n")
                .out_time_seconds,
            Some(2.5)
        );
    }

    #[test]
    fn prefers_out_time_us_within_a_block_also_when_out_time_ms_comes_first() {
        let mut parser = ProgressParser::new();

        assert_eq!(
            parser
                .feed("out_time_ms=1\nout_time_us=2000000\nprogress=continue\n")
                .out_time_seconds,
            Some(2.0)
        );
        // Next block has only ms again: the fallback applies again.
        assert_eq!(
            parser
                .feed("out_time_ms=4000000\nprogress=continue\n")
                .out_time_seconds,
            Some(4.0)
        );
    }

    #[test]
    fn ignores_na_and_negative_values() {
        let mut parser = ProgressParser::new();

        assert_eq!(
            parser.feed("out_time_us=N/A\nout_time_ms=N/A\nout_time=N/A\nprogress=continue\n"),
            ProgressUpdate {
                out_time_seconds: None,
                ended: false
            }
        );
        assert_eq!(
            parser
                .feed("out_time_us=-9223372036854775808\nprogress=continue\n")
                .out_time_seconds,
            None
        );
    }

    #[test]
    fn handles_crlf_line_endings_and_unrelated_keys() {
        let mut parser = ProgressParser::new();

        assert_eq!(
            parser
                .feed("bitrate=N/A\r\nout_time_us=1000000\r\nprogress=continue\r\n")
                .out_time_seconds,
            Some(1.0)
        );
    }

    #[test]
    fn detects_progress_end_and_keeps_it_sticky() {
        let mut parser = ProgressParser::new();

        assert!(parser.feed("progress=end\n").ended);
        assert!(parser.feed("frame=1\n").ended);
    }

    #[test]
    fn flush_processes_a_final_line_without_newline() {
        let mut parser = ProgressParser::new();

        parser.feed("out_time_us=5000000");

        assert_eq!(
            parser.flush(),
            ProgressUpdate {
                out_time_seconds: Some(5.0),
                ended: false
            }
        );
        assert_eq!(
            parser.flush(),
            ProgressUpdate {
                out_time_seconds: None,
                ended: false
            }
        );
    }

    #[test]
    fn flush_can_complete_progress_end() {
        let mut parser = ProgressParser::new();

        parser.feed("progress=end");

        assert!(parser.flush().ended);
    }

    #[test]
    fn to_fraction_divides_by_the_duration() {
        assert_eq!(to_fraction(15.0, Some(60.0), 0.0), Some(0.25));
    }

    #[test]
    fn to_fraction_clamps_to_0_1() {
        assert_eq!(to_fraction(90.0, Some(60.0), 0.0), Some(1.0));
        assert_eq!(to_fraction(-5.0, Some(60.0), 0.0), Some(0.0));
    }

    #[test]
    fn to_fraction_never_goes_below_the_previous_value() {
        assert_eq!(to_fraction(10.0, Some(100.0), 0.5), Some(0.5));
        assert_eq!(to_fraction(60.0, Some(100.0), 0.5), Some(0.6));
    }

    #[test]
    fn to_fraction_is_none_for_an_unusable_duration() {
        for duration in [None, Some(0.0), Some(-1.0), Some(f64::NAN)] {
            assert_eq!(to_fraction(10.0, duration, 0.0), None, "{duration:?}");
        }
    }

    #[test]
    fn to_fraction_treats_a_non_finite_out_time_as_no_progress() {
        assert_eq!(to_fraction(f64::NAN, Some(10.0), 0.3), Some(0.3));
    }
}
