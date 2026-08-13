use sha2::{Digest, Sha256};
use std::{collections::HashMap, fmt};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PatchRuleId(String);

impl PatchRuleId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PatchRuleId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyPatchCatalog {
    pub source_sha256: String,
    pub rules: Vec<LegacyPatchRule>,
}

impl LegacyPatchCatalog {
    pub fn parse(source: &str) -> Result<Self, LegacyPatchError> {
        let canonical_source = source.replace("\r\n", "\n");
        if canonical_source.contains('\r') {
            return Err(invalid(
                0,
                "catalog contains a non-canonical carriage return",
            ));
        }
        let source_sha256 = hex_digest(Sha256::digest(canonical_source.as_bytes()));
        let mut rules = Vec::new();
        let mut first_line_by_id = HashMap::new();
        let mut description = None;

        for (index, raw_line) in canonical_source.lines().enumerate() {
            let line_number = index + 1;
            let line = raw_line.trim();
            if line.is_empty() {
                description = None;
                continue;
            }
            if let Some(comment) = line.strip_prefix('#') {
                let comment = comment.trim();
                if !comment.is_empty() && !looks_like_commented_rule(comment) {
                    description = Some(comment.to_owned());
                }
                continue;
            }

            let fields: Vec<_> = line.split_ascii_whitespace().collect();
            if fields.len() != 3 {
                return Err(invalid(
                    line_number,
                    "a rule must contain exactly GUID, section type, and one pattern patch",
                ));
            }
            let file_guid = parse_guid(fields[0], line_number)?;
            let section_type = u8::from_str_radix(fields[1], 16).map_err(|_| {
                invalid(
                    line_number,
                    "section type is not an 8-bit hexadecimal value",
                )
            })?;
            let patch_fields: Vec<_> = fields[2].split(':').collect();
            if patch_fields.len() != 3 || patch_fields[0] != "P" {
                return Err(invalid(
                    line_number,
                    "only one P:<find>:<replace> patch is supported per rule",
                ));
            }
            let find = MaskedPattern::parse(patch_fields[1], line_number, PatternKind::Find)?;
            let replace = MaskedPattern::parse(patch_fields[2], line_number, PatternKind::Replace)?;
            if find.len() != replace.len() {
                return Err(invalid(
                    line_number,
                    "find and replacement patterns must have the same byte length",
                ));
            }

            let id = rule_id(file_guid, section_type, &find.text, &replace.text);
            if let Some(first_line) = first_line_by_id.insert(id.clone(), line_number) {
                return Err(LegacyPatchError::DuplicateRule {
                    rule_id: id,
                    first_line,
                    duplicate_line: line_number,
                });
            }
            rules.push(LegacyPatchRule {
                id,
                description: description.clone(),
                source_line: line_number,
                file_guid,
                section_type,
                find,
                replace,
            });
        }

        if rules.is_empty() {
            return Err(invalid(0, "catalog contains no active rules"));
        }
        Ok(Self {
            source_sha256,
            rules,
        })
    }

    pub fn rule(&self, id: &PatchRuleId) -> Option<&LegacyPatchRule> {
        self.rules.iter().find(|rule| rule.id == *id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyPatchRule {
    pub id: PatchRuleId,
    pub description: Option<String>,
    pub source_line: usize,
    pub file_guid: [u8; 16],
    pub section_type: u8,
    find: MaskedPattern,
    replace: MaskedPattern,
}

impl LegacyPatchRule {
    pub fn find_pattern(&self) -> &str {
        &self.find.text
    }

    pub fn replacement_pattern(&self) -> &str {
        &self.replace.text
    }

    pub fn matching_offsets(&self, section_body: &[u8]) -> Vec<usize> {
        if section_body.len() < self.find.len() {
            return Vec::new();
        }
        section_body
            .windows(self.find.len())
            .enumerate()
            .filter_map(|(offset, candidate)| self.find.matches(candidate).then_some(offset))
            .collect()
    }

    pub fn apply_exact(
        &self,
        section_body: &[u8],
        expected_matches: usize,
    ) -> Result<(Vec<u8>, LegacyPatchApplication), LegacyPatchError> {
        if expected_matches == 0 {
            return Err(LegacyPatchError::ExpectedMatchesMustBePositive {
                rule_id: self.id.clone(),
            });
        }
        let offsets = self.matching_offsets(section_body);
        if offsets.len() != expected_matches {
            return Err(LegacyPatchError::MatchCount {
                rule_id: self.id.clone(),
                expected: expected_matches,
                actual: offsets.len(),
            });
        }
        if offsets
            .windows(2)
            .any(|pair| pair[1] < pair[0] + self.find.len())
        {
            return Err(LegacyPatchError::OverlappingMatches {
                rule_id: self.id.clone(),
            });
        }

        let mut patched = section_body.to_vec();
        let mut changes = Vec::with_capacity(offsets.len());
        for offset in offsets {
            let end = offset + self.find.len();
            let before = section_body[offset..end].to_vec();
            let after = self.replace.apply(&before);
            if before == after {
                return Err(LegacyPatchError::NoChange {
                    rule_id: self.id.clone(),
                    offset,
                });
            }
            patched[offset..end].copy_from_slice(&after);
            changes.push(LegacyPatchChange {
                offset,
                before,
                after,
            });
        }

        let application = LegacyPatchApplication {
            rule_id: self.id.clone(),
            file_guid: self.file_guid,
            section_type: self.section_type,
            changes,
        };
        Ok((patched, application))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyPatchApplication {
    pub rule_id: PatchRuleId,
    pub file_guid: [u8; 16],
    pub section_type: u8,
    pub changes: Vec<LegacyPatchChange>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyPatchChange {
    pub offset: usize,
    pub before: Vec<u8>,
    pub after: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LegacyPatchError {
    InvalidCatalog {
        line: usize,
        reason: String,
    },
    DuplicateRule {
        rule_id: PatchRuleId,
        first_line: usize,
        duplicate_line: usize,
    },
    ExpectedMatchesMustBePositive {
        rule_id: PatchRuleId,
    },
    MatchCount {
        rule_id: PatchRuleId,
        expected: usize,
        actual: usize,
    },
    OverlappingMatches {
        rule_id: PatchRuleId,
    },
    NoChange {
        rule_id: PatchRuleId,
        offset: usize,
    },
}

impl fmt::Display for LegacyPatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidCatalog { line, reason } if *line == 0 => {
                write!(formatter, "invalid legacy patch catalog: {reason}")
            }
            Self::InvalidCatalog { line, reason } => {
                write!(
                    formatter,
                    "invalid legacy patch catalog at line {line}: {reason}"
                )
            }
            Self::DuplicateRule {
                rule_id,
                first_line,
                duplicate_line,
            } => write!(
                formatter,
                "legacy patch rule {rule_id} is duplicated at lines {first_line} and {duplicate_line}"
            ),
            Self::ExpectedMatchesMustBePositive { rule_id } => write!(
                formatter,
                "legacy patch rule {rule_id} requires a positive expected match count"
            ),
            Self::MatchCount {
                rule_id,
                expected,
                actual,
            } => write!(
                formatter,
                "legacy patch rule {rule_id} matched {actual} times instead of the required {expected}"
            ),
            Self::OverlappingMatches { rule_id } => {
                write!(
                    formatter,
                    "legacy patch rule {rule_id} has overlapping matches"
                )
            }
            Self::NoChange { rule_id, offset } => write!(
                formatter,
                "legacy patch rule {rule_id} would not change the match at offset {offset:#x}"
            ),
        }
    }
}

impl std::error::Error for LegacyPatchError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PatternKind {
    Find,
    Replace,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct MaskedPattern {
    text: String,
    values: Vec<u8>,
    masks: Vec<u8>,
}

impl MaskedPattern {
    fn parse(text: &str, line: usize, kind: PatternKind) -> Result<Self, LegacyPatchError> {
        if text.is_empty() || !text.len().is_multiple_of(2) {
            return Err(invalid(
                line,
                "patterns must contain a positive, even number of hexadecimal or wildcard nibbles",
            ));
        }
        let mut values = Vec::with_capacity(text.len() / 2);
        let mut masks = Vec::with_capacity(text.len() / 2);
        let bytes = text.as_bytes();
        for pair in bytes.chunks_exact(2) {
            let (high_value, high_mask) = parse_nibble(pair[0], line)?;
            let (low_value, low_mask) = parse_nibble(pair[1], line)?;
            values.push((high_value << 4) | low_value);
            masks.push((high_mask << 4) | low_mask);
        }
        if kind == PatternKind::Find && masks.iter().all(|mask| *mask == 0) {
            return Err(invalid(
                line,
                "find pattern cannot consist only of wildcards",
            ));
        }
        if kind == PatternKind::Replace && masks.iter().all(|mask| *mask == 0) {
            return Err(invalid(
                line,
                "replacement pattern cannot preserve every nibble",
            ));
        }
        Ok(Self {
            text: text.to_ascii_uppercase(),
            values,
            masks,
        })
    }

    fn len(&self) -> usize {
        self.values.len()
    }

    fn matches(&self, candidate: &[u8]) -> bool {
        candidate
            .iter()
            .zip(self.values.iter().zip(&self.masks))
            .all(|(candidate, (value, mask))| candidate & mask == *value)
    }

    fn apply(&self, original: &[u8]) -> Vec<u8> {
        original
            .iter()
            .zip(self.values.iter().zip(&self.masks))
            .map(|(original, (value, mask))| (original & !mask) | value)
            .collect()
    }
}

fn parse_nibble(byte: u8, line: usize) -> Result<(u8, u8), LegacyPatchError> {
    match byte {
        b'0'..=b'9' => Ok((byte - b'0', 0x0f)),
        b'a'..=b'f' => Ok((byte - b'a' + 10, 0x0f)),
        b'A'..=b'F' => Ok((byte - b'A' + 10, 0x0f)),
        b'.' => Ok((0, 0)),
        _ => Err(invalid(
            line,
            "patterns may contain only hexadecimal digits and '.' wildcards",
        )),
    }
}

fn parse_guid(text: &str, line: usize) -> Result<[u8; 16], LegacyPatchError> {
    let fields: Vec<_> = text.split('-').collect();
    if fields.len() != 5
        || fields[0].len() != 8
        || fields[1].len() != 4
        || fields[2].len() != 4
        || fields[3].len() != 4
        || fields[4].len() != 12
    {
        return Err(invalid(line, "file GUID is malformed"));
    }
    let data1 =
        u32::from_str_radix(fields[0], 16).map_err(|_| invalid(line, "file GUID is malformed"))?;
    let data2 =
        u16::from_str_radix(fields[1], 16).map_err(|_| invalid(line, "file GUID is malformed"))?;
    let data3 =
        u16::from_str_radix(fields[2], 16).map_err(|_| invalid(line, "file GUID is malformed"))?;
    let tail = format!("{}{}", fields[3], fields[4]);
    let mut guid = [0_u8; 16];
    guid[..4].copy_from_slice(&data1.to_le_bytes());
    guid[4..6].copy_from_slice(&data2.to_le_bytes());
    guid[6..8].copy_from_slice(&data3.to_le_bytes());
    for (index, pair) in tail.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(pair).expect("GUID pairs are ASCII boundaries");
        guid[8 + index] =
            u8::from_str_radix(pair, 16).map_err(|_| invalid(line, "file GUID is malformed"))?;
    }
    Ok(guid)
}

fn looks_like_commented_rule(comment: &str) -> bool {
    let first = comment.split_ascii_whitespace().next().unwrap_or_default();
    first.len() == 36 && first.bytes().filter(|byte| *byte == b'-').count() == 4
}

fn rule_id(file_guid: [u8; 16], section_type: u8, find: &str, replace: &str) -> PatchRuleId {
    let mut hasher = Sha256::new();
    hasher.update(file_guid);
    hasher.update([section_type]);
    hasher.update(find.as_bytes());
    hasher.update([0]);
    hasher.update(replace.as_bytes());
    PatchRuleId(hex_digest(hasher.finalize()))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use fmt::Write;
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
}

fn invalid(line: usize, reason: impl Into<String>) -> LegacyPatchError {
    LegacyPatchError::InvalidCatalog {
        line,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUID: &str = "8D6756B9-E55E-4D6A-A3A5-5E4D72DDF772";

    #[test]
    fn parses_uefipatch_guid_section_and_wildcards() {
        let source = format!(
            "# Match selected nibbles\n{GUID} 10 P:A.B.:1...\n\n# Disabled\n#{GUID} 10 P:AABB:CCDD\n"
        );
        let catalog = LegacyPatchCatalog::parse(&source).unwrap();

        assert_eq!(catalog.rules.len(), 1);
        let rule = &catalog.rules[0];
        assert_eq!(rule.description.as_deref(), Some("Match selected nibbles"));
        assert_eq!(rule.section_type, 0x10);
        assert_eq!(
            rule.file_guid,
            [
                0xb9, 0x56, 0x67, 0x8d, 0x5e, 0xe5, 0x6a, 0x4d, 0xa3, 0xa5, 0x5e, 0x4d, 0x72, 0xdd,
                0xf7, 0x72,
            ]
        );
        assert_eq!(rule.find_pattern(), "A.B.");
        assert_eq!(rule.replacement_pattern(), "1...");
        assert_eq!(
            rule.matching_offsets(&[0xaf, 0xb2, 0x00, 0xab, 0xb3]),
            [0, 3]
        );

        let (patched, report) = rule
            .apply_exact(&[0xaf, 0xb2, 0x00, 0xab, 0xb3], 2)
            .unwrap();
        assert_eq!(patched, [0x1f, 0xb2, 0x00, 0x1b, 0xb3]);
        assert_eq!(report.changes[0].before, [0xaf, 0xb2]);
        assert_eq!(report.changes[0].after, [0x1f, 0xb2]);
    }

    #[test]
    fn requires_an_explicit_exact_match_count_before_mutation() {
        let source = format!("{GUID} 10 P:AABB:CCDD\n");
        let catalog = LegacyPatchCatalog::parse(&source).unwrap();
        let rule = &catalog.rules[0];

        assert!(matches!(
            rule.apply_exact(&[0xaa, 0xbb, 0xaa, 0xbb], 1),
            Err(LegacyPatchError::MatchCount {
                expected: 1,
                actual: 2,
                ..
            })
        ));
        assert!(matches!(
            rule.apply_exact(&[0xaa, 0xbb], 0),
            Err(LegacyPatchError::ExpectedMatchesMustBePositive { .. })
        ));
    }

    #[test]
    fn rejects_ambiguous_or_ineffective_patterns() {
        for patch in ["P:...:AABB", "P:AABB:CC", "P:AABB:....", "P:AAB:CCD"] {
            let source = format!("{GUID} 10 {patch}\n");
            assert!(matches!(
                LegacyPatchCatalog::parse(&source),
                Err(LegacyPatchError::InvalidCatalog { .. })
            ));
        }

        let source = format!("{GUID} 10 P:AABB:A.B.\n");
        let catalog = LegacyPatchCatalog::parse(&source).unwrap();
        assert!(matches!(
            catalog.rules[0].apply_exact(&[0xaa, 0xbb], 1),
            Err(LegacyPatchError::NoChange { offset: 0, .. })
        ));
    }

    #[test]
    fn rejects_overlapping_matches_and_duplicate_rules() {
        let source = format!("{GUID} 10 P:AAAA:BBBB\n");
        let catalog = LegacyPatchCatalog::parse(&source).unwrap();
        assert!(matches!(
            catalog.rules[0].apply_exact(&[0xaa, 0xaa, 0xaa], 2),
            Err(LegacyPatchError::OverlappingMatches { .. })
        ));

        let duplicate = format!("{GUID} 10 P:AAAA:BBBB\n{GUID} 10 P:AAAA:BBBB\n");
        assert!(matches!(
            LegacyPatchCatalog::parse(&duplicate),
            Err(LegacyPatchError::DuplicateRule { .. })
        ));
    }

    #[test]
    fn catalog_digest_is_stable_across_git_line_endings() {
        let lf = format!("# rule\n{GUID} 10 P:AABB:CCDD\n");
        let crlf = lf.replace('\n', "\r\n");

        let lf_catalog = LegacyPatchCatalog::parse(&lf).unwrap();
        let crlf_catalog = LegacyPatchCatalog::parse(&crlf).unwrap();

        assert_eq!(lf_catalog.source_sha256, crlf_catalog.source_sha256);
        assert_eq!(lf_catalog.rules, crlf_catalog.rules);
    }
}
