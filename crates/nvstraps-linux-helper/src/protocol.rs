use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
/// Maximum wire line length, including its terminating newline.
pub const MAX_LINE_BYTES: usize = 16 * 1024;

/// First line the helper prints. `privileged` means its effective user id is 0.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol: u32,
    pub privileged: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HelloLine {
    pub hello: Hello,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    /// Lower-case hex of the complete data, without the efivarfs attribute word.
    WriteConfiguration {
        data_hex: String,
    },
    DeleteConfiguration,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestLine {
    pub id: u64,
    pub request: Request,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    BadRequest,
    InvalidConfiguration,
    NotUefi,
    Io,
    ReadbackMismatch,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseLine {
    pub id: Option<u64>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

pub fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

pub fn decode_hex(text: &str) -> Option<Vec<u8>> {
    fn digit(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        }
    }

    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| Some((digit(pair[0])? << 4) | digit(pair[1])?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_wire<T>(value: T, expected: &str)
    where
        T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug,
    {
        assert_eq!(serde_json::to_string(&value).unwrap(), expected);
        assert_eq!(serde_json::from_str::<T>(expected).unwrap(), value);
    }

    #[test]
    fn exact_wire_shapes() {
        assert_wire(
            HelloLine {
                hello: Hello {
                    protocol: PROTOCOL_VERSION,
                    privileged: true,
                },
            },
            r#"{"hello":{"protocol":1,"privileged":true}}"#,
        );
        assert_wire(
            Request::WriteConfiguration {
                data_hex: "00af".into(),
            },
            r#"{"kind":"writeConfiguration","dataHex":"00af"}"#,
        );
        assert_wire(
            Request::DeleteConfiguration,
            r#"{"kind":"deleteConfiguration"}"#,
        );
        assert_wire(
            RequestLine {
                id: 1,
                request: Request::DeleteConfiguration,
            },
            r#"{"id":1,"request":{"kind":"deleteConfiguration"}}"#,
        );
        assert_wire(
            ResponseLine {
                id: Some(1),
                ok: true,
                error: None,
            },
            r#"{"id":1,"ok":true}"#,
        );
        assert_wire(
            ResponseLine {
                id: None,
                ok: false,
                error: Some(ErrorBody {
                    code: ErrorCode::BadRequest,
                    message: "invalid JSON".into(),
                }),
            },
            r#"{"id":null,"ok":false,"error":{"code":"badRequest","message":"invalid JSON"}}"#,
        );
        for (code, expected) in [
            (ErrorCode::BadRequest, r#""badRequest""#),
            (ErrorCode::InvalidConfiguration, r#""invalidConfiguration""#),
            (ErrorCode::NotUefi, r#""notUefi""#),
            (ErrorCode::Io, r#""io""#),
            (ErrorCode::ReadbackMismatch, r#""readbackMismatch""#),
        ] {
            assert_wire(code, expected);
        }
    }

    #[test]
    fn hex_round_trip_and_strict_alphabet() {
        let bytes: Vec<u8> = (0..=255).collect();
        assert_eq!(decode_hex(&encode_hex(&bytes)), Some(bytes));
        assert_eq!(encode_hex(&[0, 10, 175, 255]), "000aafff");
        assert_eq!(decode_hex(""), Some(vec![]));
        for invalid in ["0", "abc", "AF", "aF", "gg", "00 0", "é"] {
            assert_eq!(decode_hex(invalid), None, "{invalid:?}");
        }
    }
}
