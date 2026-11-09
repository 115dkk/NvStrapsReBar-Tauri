use std::io::{self, BufRead, Read, Write};

use nvstraps_core::config::{Config, MAX_ENCODED_SIZE};
use serde::Serialize;

use crate::protocol::{
    ErrorBody, ErrorCode, Hello, HelloLine, MAX_LINE_BYTES, PROTOCOL_VERSION, Request, RequestLine,
    ResponseLine, decode_hex,
};

pub trait ConfigurationStore {
    fn write(&mut self, data: &[u8]) -> Result<(), StoreError>;
    fn delete(&mut self) -> Result<(), StoreError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub code: ErrorCode,
    pub message: String,
}

/// Prints the hello line, then answers one request line at a time until end of input.
pub fn serve(
    mut input: impl BufRead,
    mut output: impl Write,
    privileged: bool,
    store: &mut impl ConfigurationStore,
) -> io::Result<()> {
    write_line(
        &mut output,
        &HelloLine {
            hello: Hello {
                protocol: PROTOCOL_VERSION,
                privileged,
            },
        },
    )?;

    let mut line = Vec::new();
    loop {
        line.clear();
        // Take bounds even a reader that never sends a newline; never drain an oversized line.
        let count = (&mut input)
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            return Ok(());
        }
        if count > MAX_LINE_BYTES {
            write_line(
                &mut output,
                &failure(None, ErrorCode::BadRequest, "request line is too long"),
            )?;
            return Ok(());
        }
        if line.last() != Some(&b'\n') {
            write_line(
                &mut output,
                &failure(
                    request_id(&line),
                    ErrorCode::BadRequest,
                    "request line must end with a newline",
                ),
            )?;
            return Ok(());
        }
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }

        let request = match serde_json::from_slice::<RequestLine>(&line) {
            Ok(request) => request,
            Err(error) => {
                write_line(
                    &mut output,
                    &failure(request_id(&line), ErrorCode::BadRequest, error.to_string()),
                )?;
                continue;
            }
        };
        let result = match request.request {
            Request::WriteConfiguration { data_hex } => validate_and_write(&data_hex, store),
            Request::DeleteConfiguration => store.delete(),
        };
        let response = match result {
            Ok(()) => ResponseLine {
                id: Some(request.id),
                ok: true,
                error: None,
            },
            Err(error) => failure(Some(request.id), error.code, error.message),
        };
        write_line(&mut output, &response)?;
    }
}

fn request_id(line: &[u8]) -> Option<u64> {
    serde_json::from_slice::<serde_json::Value>(line)
        .ok()?
        .get("id")?
        .as_u64()
}

fn failure(id: Option<u64>, code: ErrorCode, message: impl Into<String>) -> ResponseLine {
    ResponseLine {
        id,
        ok: false,
        error: Some(ErrorBody {
            code,
            message: message.into(),
        }),
    }
}

fn write_line(output: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn validate_and_write(
    data_hex: &str,
    store: &mut impl ConfigurationStore,
) -> Result<(), StoreError> {
    let data = decode_hex(data_hex).ok_or_else(|| StoreError {
        code: ErrorCode::BadRequest,
        message: "dataHex must contain an even number of lower-case hexadecimal digits".into(),
    })?;
    if data.is_empty() {
        return Err(StoreError {
            code: ErrorCode::BadRequest,
            message: "empty configuration data; use deleteConfiguration instead".into(),
        });
    }
    if data.len() > MAX_ENCODED_SIZE {
        return Err(StoreError {
            code: ErrorCode::InvalidConfiguration,
            message: format!("configuration exceeds {MAX_ENCODED_SIZE} bytes"),
        });
    }
    let invalid = |message: String| StoreError {
        code: ErrorCode::InvalidConfiguration,
        message,
    };
    let config = Config::decode(&data).map_err(|error| invalid(error.to_string()))?;
    // The decoder tolerates trailing bytes and layouts the encoder never produces. A privileged
    // write takes only the exact bytes the application's own encoder emits for that configuration.
    let canonical = config
        .encode()
        .map_err(|error| invalid(error.to_string()))?;
    if canonical[..] != data[..] {
        return Err(invalid(
            "configuration bytes are not in the encoder's canonical form".into(),
        ));
    }
    store.write(&data)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use crate::protocol::encode_hex;

    use super::*;

    #[derive(Default)]
    struct FakeStore {
        writes: Vec<Vec<u8>>,
        deletes: usize,
        error: Option<StoreError>,
    }

    impl ConfigurationStore for FakeStore {
        fn write(&mut self, data: &[u8]) -> Result<(), StoreError> {
            self.writes.push(data.to_vec());
            self.error.clone().map_or(Ok(()), Err)
        }

        fn delete(&mut self) -> Result<(), StoreError> {
            self.deletes += 1;
            self.error.clone().map_or(Ok(()), Err)
        }
    }

    #[derive(Default)]
    struct Output {
        bytes: Vec<u8>,
        flushes: usize,
    }

    impl Write for Output {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            assert_eq!(self.bytes.last(), Some(&b'\n'));
            self.flushes += 1;
            Ok(())
        }
    }

    fn run(input: &[u8], privileged: bool, store: &mut FakeStore) -> Vec<ResponseLine> {
        let mut output = Output::default();
        serve(Cursor::new(input), &mut output, privileged, store).unwrap();
        let text = String::from_utf8(output.bytes).unwrap();
        assert!(text.ends_with('\n'));
        let mut lines = text.lines();
        let hello: HelloLine = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(hello.hello.protocol, PROTOCOL_VERSION);
        assert_eq!(hello.hello.privileged, privileged);
        let responses: Vec<ResponseLine> = lines
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(output.flushes, responses.len() + 1);
        responses
    }

    fn request(id: u64, request: Request) -> String {
        format!(
            "{}\n",
            serde_json::to_string(&RequestLine { id, request }).unwrap()
        )
    }

    fn write_request(id: u64, data: &[u8]) -> String {
        request(
            id,
            Request::WriteConfiguration {
                data_hex: encode_hex(data),
            },
        )
    }

    fn valid_data() -> Vec<u8> {
        Config {
            target_pci_bar_size: 1,
            ..Config::default()
        }
        .encode()
        .unwrap()
    }

    #[test]
    fn valid_configuration_and_delete_reach_store_and_echo_ids() {
        let data = valid_data();
        assert!(!data.is_empty());
        let input = write_request(u64::MAX, &data) + &request(2, Request::DeleteConfiguration);
        let mut store = FakeStore::default();
        let responses = run(input.as_bytes(), true, &mut store);
        assert_eq!(store.writes, vec![data]);
        assert_eq!(store.deletes, 1);
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].id, Some(u64::MAX));
        assert_eq!(responses[1].id, Some(2));
        assert!(responses.iter().all(|r| r.ok && r.error.is_none()));
    }

    #[test]
    fn rejects_invalid_empty_oversized_and_malformed_hex_without_store_calls() {
        let mut store = FakeStore::default();
        let input = write_request(1, &[0xff])
            + &write_request(2, &[])
            + &write_request(3, &vec![0; MAX_ENCODED_SIZE + 1])
            + &request(
                4,
                Request::WriteConfiguration {
                    data_hex: "AB".into(),
                },
            );
        let responses = run(input.as_bytes(), false, &mut store);
        assert_eq!(responses.len(), 4);
        for (response, (id, code)) in responses.iter().zip([
            (1, ErrorCode::InvalidConfiguration),
            (2, ErrorCode::BadRequest),
            (3, ErrorCode::InvalidConfiguration),
            (4, ErrorCode::BadRequest),
        ]) {
            assert_eq!(response.id, Some(id));
            assert!(!response.ok);
            assert_eq!(response.error.as_ref().unwrap().code, code);
        }
        assert_eq!(
            responses[0].error.as_ref().unwrap().message,
            Config::decode(&[0xff]).unwrap_err().to_string()
        );
        assert!(store.writes.is_empty());
        assert_eq!(store.deletes, 0);
    }

    #[test]
    fn only_the_encoders_own_bytes_are_written() {
        let mut trailing = valid_data();
        trailing.push(0);
        // Decodes, but to a configuration the encoder writes as "no variable".
        let unconfigured = vec![0; valid_data().len()];
        assert!(Config::decode(&trailing).is_ok());
        assert!(Config::decode(&unconfigured).is_ok());
        let mut store = FakeStore::default();
        let input = write_request(1, &trailing) + &write_request(2, &unconfigured);
        let responses = run(input.as_bytes(), true, &mut store);
        assert_eq!(responses.len(), 2);
        for response in &responses {
            assert!(!response.ok);
            assert_eq!(
                response.error.as_ref().unwrap().code,
                ErrorCode::InvalidConfiguration
            );
        }
        assert!(store.writes.is_empty());
    }

    #[test]
    fn malformed_requests_do_not_stop_next_request_and_recover_known_ids() {
        let mut store = FakeStore::default();
        let input = concat!(
            "\n\r\n",
            "not json\n",
            "{\"id\":42,\"request\":{\"kind\":\"unknown\"}}\n",
            "{\"id\":\"42\"}\n",
            "{\"id\":3,\"request\":{\"kind\":\"deleteConfiguration\"}}\n"
        );
        let responses = run(input.as_bytes(), false, &mut store);
        assert_eq!(responses.len(), 4);
        for (response, id) in responses[..3].iter().zip([None, Some(42), None]) {
            assert_eq!(response.id, id);
            assert_eq!(response.error.as_ref().unwrap().code, ErrorCode::BadRequest);
        }
        assert_eq!(responses[3].id, Some(3));
        assert!(responses[3].ok);
        assert_eq!(store.deletes, 1);
    }

    #[test]
    fn invalid_utf8_is_a_bad_request_and_session_continues() {
        let mut input = vec![0xff, b'\n'];
        input.extend_from_slice(request(8, Request::DeleteConfiguration).as_bytes());
        let mut store = FakeStore::default();
        let responses = run(&input, false, &mut store);
        assert_eq!(responses[0].id, None);
        assert_eq!(
            responses[0].error.as_ref().unwrap().code,
            ErrorCode::BadRequest
        );
        assert!(responses[1].ok);
        assert_eq!(store.deletes, 1);
    }

    #[test]
    fn overlong_line_stops_after_at_most_limit_plus_one_bytes() {
        let input = vec![b'x'; MAX_LINE_BYTES * 2];
        let mut reader = Cursor::new(input);
        let mut output = Vec::new();
        let mut store = FakeStore::default();
        serve(&mut reader, &mut output, false, &mut store).unwrap();
        assert_eq!(reader.position(), (MAX_LINE_BYTES + 1) as u64);
        let text = String::from_utf8(output).unwrap();
        assert_eq!(text.lines().count(), 2);
        let response: ResponseLine = serde_json::from_str(text.lines().nth(1).unwrap()).unwrap();
        assert_eq!(response.id, None);
        assert_eq!(response.error.unwrap().code, ErrorCode::BadRequest);
        assert_eq!(store.deletes, 0);
        assert!(store.writes.is_empty());
    }

    #[test]
    fn exact_limit_is_allowed_and_next_request_is_served() {
        let first = request(1, Request::DeleteConfiguration);
        let input = " ".repeat(MAX_LINE_BYTES - first.len())
            + &first
            + &request(2, Request::DeleteConfiguration);
        let mut store = FakeStore::default();
        let responses = run(input.as_bytes(), false, &mut store);
        assert_eq!(responses.len(), 2);
        assert!(responses.iter().all(|response| response.ok));
        assert_eq!(store.deletes, 2);
    }

    #[test]
    fn unterminated_request_is_not_executed() {
        let input = request(9, Request::DeleteConfiguration);
        let mut store = FakeStore::default();
        let responses = run(input.trim_end().as_bytes(), false, &mut store);
        assert_eq!(responses[0].id, Some(9));
        assert_eq!(
            responses[0].error.as_ref().unwrap().code,
            ErrorCode::BadRequest
        );
        assert_eq!(store.deletes, 0);
    }

    #[test]
    fn store_errors_are_preserved_for_both_operations() {
        let error = StoreError {
            code: ErrorCode::ReadbackMismatch,
            message: "readback differs".into(),
        };
        let mut store = FakeStore {
            error: Some(error.clone()),
            ..FakeStore::default()
        };
        let input = write_request(1, &valid_data()) + &request(2, Request::DeleteConfiguration);
        let responses = run(input.as_bytes(), false, &mut store);
        assert_eq!(responses.len(), 2);
        for response in responses {
            assert!(!response.ok);
            let body = response.error.unwrap();
            assert_eq!(body.code, error.code);
            assert_eq!(body.message, error.message);
        }
    }

    #[test]
    fn empty_input_still_prints_hello() {
        for privileged in [false, true] {
            assert!(run(b"", privileged, &mut FakeStore::default()).is_empty());
        }
    }
}
