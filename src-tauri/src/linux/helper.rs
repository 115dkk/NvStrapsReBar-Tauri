use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Mutex, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use nvstraps_linux_helper::protocol::{
    self, ErrorCode, HelloLine, Request, RequestLine, ResponseLine,
};

use super::{SystemRoots, process, trusted::trusted_executable};
use crate::{
    error::{BackendError, BackendResult},
    firmware::CONFIG_VARIABLE_NAME,
};

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// Whether `SESSION` held a live helper when it was last looked at under the lock.
static SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);

struct Session {
    child: Child,
    connection: Connection<BufReader<ChildStdout>, ChildStdin>,
}

/// Request/response exchange with a running helper, independent of how it was started.
struct Connection<R: BufRead, W: Write> {
    reader: R,
    writer: W,
    next_id: u64,
    transport_failed: bool,
}

impl<R: BufRead, W: Write> Connection<R, W> {
    /// Reads the hello line. Wrong protocol version or `privileged == false` is an error.
    fn open(mut reader: R, writer: W) -> BackendResult<Self> {
        let line = read_bounded_line(&mut reader).map_err(BackendError::Elevation)?;
        let hello: HelloLine = serde_json::from_slice(&line)
            .map_err(|error| BackendError::Elevation(format!("invalid helper hello: {error}")))?;
        if hello.hello.protocol != protocol::PROTOCOL_VERSION {
            return Err(BackendError::Elevation(format!(
                "helper protocol version {} does not match application version {}",
                hello.hello.protocol,
                protocol::PROTOCOL_VERSION
            )));
        }
        if !hello.hello.privileged {
            return Err(BackendError::Elevation(
                "the helper did not obtain administrator rights".into(),
            ));
        }
        Ok(Self {
            reader,
            writer,
            next_id: 1,
            transport_failed: false,
        })
    }

    fn call(&mut self, request: Request) -> BackendResult<()> {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        let line = RequestLine { id, request };
        if let Err(error) = serde_json::to_writer(&mut self.writer, &line) {
            return Err(self.transport_failure(format!("failed to encode helper request: {error}")));
        }
        if let Err(error) = self
            .writer
            .write_all(b"\n")
            .and_then(|()| self.writer.flush())
        {
            return Err(self.transport_failure(format!("failed to send helper request: {error}")));
        }

        let response = match read_bounded_line(&mut self.reader) {
            Ok(response) => response,
            Err(reason) => return Err(self.transport_failure(reason)),
        };
        let response: ResponseLine = match serde_json::from_slice(&response) {
            Ok(response) => response,
            Err(error) => {
                return Err(self.transport_failure(format!("invalid helper response: {error}")));
            }
        };
        if response.id != Some(id) {
            return Err(self.transport_failure(format!(
                "helper response id {:?} did not match request id {id}",
                response.id
            )));
        }
        if response.ok {
            return Ok(());
        }
        let Some(error) = response.error else {
            return Err(self.transport_failure("helper returned an error without details".into()));
        };
        Err(match error.code {
            ErrorCode::InvalidConfiguration => BackendError::InvalidConfiguration(error.message),
            ErrorCode::ReadbackMismatch => BackendError::ReadbackMismatch,
            ErrorCode::NotUefi | ErrorCode::Io => BackendError::FirmwareUnavailable {
                name: CONFIG_VARIABLE_NAME,
                reason: error.message,
            },
            ErrorCode::BadRequest => BackendError::Deployment(format!(
                "the helper rejected the request: {}",
                error.message
            )),
        })
    }

    fn transport_failure(&mut self, reason: String) -> BackendError {
        self.transport_failed = true;
        transport(reason)
    }
}

fn read_bounded_line(reader: &mut impl BufRead) -> Result<Vec<u8>, String> {
    let mut line = Vec::new();
    let count = reader
        .take((protocol::MAX_LINE_BYTES + 1) as u64)
        .read_until(b'\n', &mut line)
        .map_err(|error| format!("failed to read from helper: {error}"))?;
    if count == 0 {
        return Err("helper closed its output".into());
    }
    if count > protocol::MAX_LINE_BYTES {
        return Err("helper line is too long".into());
    }
    if line.last() != Some(&b'\n') {
        return Err("helper line did not end with a newline".into());
    }
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(line)
}

fn transport(reason: String) -> BackendError {
    BackendError::FirmwareUnavailable {
        name: CONFIG_VARIABLE_NAME,
        reason,
    }
}

fn lock_session() -> BackendResult<std::sync::MutexGuard<'static, Option<Session>>> {
    SESSION.lock().map_err(|_| BackendError::StatePoisoned)
}

fn session_is_live(session: &mut Session) -> bool {
    matches!(session.child.try_wait(), Ok(None))
}

/// Ends a session without ever waiting for the helper. Closing the pipes is what stops it: the
/// helper exits at end of input. One started through pkexec runs as root, so this process cannot
/// signal it, and waiting for it while still holding its input would never return.
fn stop_session(session: Session) {
    SESSION_ACTIVE.store(false, Ordering::Release);
    let Session { child, connection } = session;
    drop(connection);
    release_child(child);
}

/// `kill` only reaches a helper this process started directly (when it is root itself). The exit
/// status is collected on its own thread, because callers may be on the main thread.
fn release_child(mut child: Child) {
    let _ = child.kill();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

/// Never waits. `start_session` holds the lock for as long as the polkit dialog stays open, and
/// every system snapshot asks this on the main thread; a held lock answers with the last known
/// state (not active while a session is still being started, active during a request).
pub(crate) fn session_active() -> bool {
    match SESSION.try_lock() {
        Ok(mut guard) => {
            let live = guard.as_mut().is_some_and(session_is_live);
            if !live && let Some(stale) = guard.take() {
                stop_session(stale);
            }
            SESSION_ACTIVE.store(live, Ordering::Release);
            live
        }
        Err(TryLockError::WouldBlock) => SESSION_ACTIVE.load(Ordering::Acquire),
        Err(TryLockError::Poisoned(_)) => false,
    }
}

/// Starts the helper if none is running. Blocks until the user answers the polkit dialog.
pub(crate) fn start_session() -> BackendResult<()> {
    let mut guard = lock_session()?;
    if guard.as_mut().is_some_and(session_is_live) {
        return Ok(());
    }
    if let Some(stale) = guard.take() {
        stop_session(stale);
    }

    let helper = helper_path()?;
    let direct = matches!(process::effective_uid(&SystemRoots::host()), Ok(0));
    let mut command = if direct {
        Command::new(&helper)
    } else {
        let pkexec = trusted_executable(&[PathBuf::from("/usr/bin/pkexec")]).ok_or_else(|| {
            BackendError::Elevation(
                "polkit's pkexec was not found at /usr/bin/pkexec; it is needed to authorise changes"
                    .into(),
            )
        })?;
        let mut command = Command::new(pkexec);
        command.arg("--disable-internal-agent").arg(&helper);
        command
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| BackendError::Elevation(error.to_string()))?;
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            return Err(cleanup_start_failure(
                child,
                "helper stdin was not piped".into(),
            ));
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            return Err(cleanup_start_failure(
                child,
                "helper stdout was not piped".into(),
            ));
        }
    };
    match Connection::open(BufReader::new(stdout), stdin) {
        Ok(connection) => {
            *guard = Some(Session { child, connection });
            SESSION_ACTIVE.store(true, Ordering::Release);
            Ok(())
        }
        Err(error) => Err(cleanup_open_failure(child, error)),
    }
}

fn helper_path() -> BackendResult<PathBuf> {
    let executable =
        std::env::current_exe().map_err(|error| BackendError::Elevation(error.to_string()))?;
    let path = executable
        .parent()
        .unwrap_or_else(|| std::path::Path::new(""))
        .join("nvstraps-rebar-helper");
    if !path.is_file() {
        return Err(BackendError::Elevation(format!(
            "the helper program was not found at {}",
            path.display()
        )));
    }
    Ok(path)
}

fn cleanup_start_failure(child: Child, reason: String) -> BackendError {
    release_child(child);
    BackendError::Elevation(reason)
}

fn cleanup_open_failure(mut child: Child, original: BackendError) -> BackendError {
    // pkexec closes its output a moment before it exits. Give it that moment, so the exit status
    // that says why (pkexec(1): 126 dialog dismissed, 127 not authorised or an error) is not
    // replaced by the kill below. The pipes were dropped with the failed connection, so a helper
    // that did start sees end of input and exits by itself.
    let mut exited = None;
    for _ in 0..50 {
        match child.try_wait() {
            Ok(Some(status)) => {
                exited = Some(status);
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break,
        }
    }
    if exited.is_none() {
        release_child(child);
    }
    match exited.and_then(|status| status.code()) {
        Some(126) => BackendError::Elevation("the authorisation dialog was dismissed".into()),
        Some(127) => BackendError::Elevation(
            "authorisation was not granted, or pkexec could not start the helper".into(),
        ),
        _ => BackendError::Elevation(match original {
            BackendError::Elevation(message) => message,
            error => error.to_string(),
        }),
    }
}

/// Empty data deletes the variable.
pub(crate) fn write_configuration(data: &[u8]) -> BackendResult<()> {
    if !session_active() {
        if matches!(process::effective_uid(&SystemRoots::host()), Ok(0)) {
            start_session()?;
        } else {
            return Err(BackendError::AdministratorRequired("save UEFI settings"));
        }
    }
    let mut guard = lock_session()?;
    let session = guard
        .as_mut()
        .ok_or(BackendError::AdministratorRequired("save UEFI settings"))?;
    let request = if data.is_empty() {
        Request::DeleteConfiguration
    } else {
        Request::WriteConfiguration {
            data_hex: protocol::encode_hex(data),
        }
    };
    let result = session.connection.call(request);
    if session.connection.transport_failed
        && let Some(failed) = guard.take()
    {
        stop_session(failed);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufReader, Cursor, pipe},
        sync::{Arc, Mutex},
        thread,
    };

    use nvstraps_core::config::Config;
    use nvstraps_linux_helper::{
        protocol::{ErrorBody, Hello, PROTOCOL_VERSION},
        serve::{ConfigurationStore, StoreError, serve},
    };

    use super::*;

    #[derive(Default)]
    struct StoreState {
        writes: Vec<Vec<u8>>,
        deletes: usize,
        error: Option<StoreError>,
    }

    struct FakeStore(Arc<Mutex<StoreState>>);

    impl ConfigurationStore for FakeStore {
        fn write(&mut self, data: &[u8]) -> Result<(), StoreError> {
            let mut state = self.0.lock().unwrap();
            state.writes.push(data.to_vec());
            state.error.clone().map_or(Ok(()), Err)
        }

        fn delete(&mut self) -> Result<(), StoreError> {
            let mut state = self.0.lock().unwrap();
            state.deletes += 1;
            state.error.clone().map_or(Ok(()), Err)
        }
    }

    fn valid_data() -> Vec<u8> {
        Config {
            target_pci_bar_size: 1,
            ..Config::default()
        }
        .encode()
        .unwrap()
    }

    fn connection(
        privileged: bool,
        state: Arc<Mutex<StoreState>>,
    ) -> Connection<BufReader<std::io::PipeReader>, std::io::PipeWriter> {
        let (client_input, server_output) = pipe().unwrap();
        let (server_input, client_output) = pipe().unwrap();
        thread::spawn(move || {
            serve(
                BufReader::new(server_input),
                server_output,
                privileged,
                &mut FakeStore(state),
            )
            .unwrap();
        });
        Connection::open(BufReader::new(client_input), client_output).unwrap()
    }

    fn hello(protocol: u32, privileged: bool) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&HelloLine {
            hello: Hello {
                protocol,
                privileged,
            },
        })
        .unwrap();
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn hello_is_accepted_and_rejects_unprivileged_wrong_version_and_eof() {
        let state = Arc::new(Mutex::new(StoreState::default()));
        drop(connection(true, state));
        assert!(matches!(
            Connection::open(Cursor::new(hello(PROTOCOL_VERSION, false)), Vec::new()),
            Err(BackendError::Elevation(_))
        ));
        assert!(matches!(
            Connection::open(Cursor::new(hello(PROTOCOL_VERSION + 1, true)), Vec::new()),
            Err(BackendError::Elevation(_))
        ));
        assert!(matches!(
            Connection::open(Cursor::new(Vec::<u8>::new()), Vec::new()),
            Err(BackendError::Elevation(_))
        ));
    }

    #[test]
    fn write_and_delete_reach_the_store() {
        let state = Arc::new(Mutex::new(StoreState::default()));
        let mut connection = connection(true, state.clone());
        let data = valid_data();
        connection
            .call(Request::WriteConfiguration {
                data_hex: protocol::encode_hex(&data),
            })
            .unwrap();
        connection.call(Request::DeleteConfiguration).unwrap();
        let state = state.lock().unwrap();
        assert_eq!(state.writes, vec![data]);
        assert_eq!(state.deletes, 1);
    }

    #[test]
    fn helper_error_codes_map_to_backend_errors() {
        for (code, expected) in [
            (ErrorCode::InvalidConfiguration, "invalid"),
            (ErrorCode::ReadbackMismatch, "readback"),
            (ErrorCode::NotUefi, "firmware"),
            (ErrorCode::Io, "firmware"),
            (ErrorCode::BadRequest, "deployment"),
        ] {
            let state = Arc::new(Mutex::new(StoreState {
                error: Some(StoreError {
                    code,
                    message: "message".into(),
                }),
                ..StoreState::default()
            }));
            let error = connection(true, state)
                .call(Request::DeleteConfiguration)
                .unwrap_err();
            assert!(matches!(
                (expected, error),
                ("invalid", BackendError::InvalidConfiguration(_))
                    | ("readback", BackendError::ReadbackMismatch)
                    | ("firmware", BackendError::FirmwareUnavailable { .. })
                    | ("deployment", BackendError::Deployment(_))
            ));
        }
    }

    fn scripted_response(response: ResponseLine) -> Vec<u8> {
        let mut bytes = hello(PROTOCOL_VERSION, true);
        bytes.extend(serde_json::to_vec(&response).unwrap());
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn wrong_response_id_is_a_transport_failure() {
        let input = scripted_response(ResponseLine {
            id: Some(2),
            ok: true,
            error: None,
        });
        let mut connection = Connection::open(Cursor::new(input), Vec::new()).unwrap();
        assert!(matches!(
            connection.call(Request::DeleteConfiguration),
            Err(BackendError::FirmwareUnavailable { .. })
        ));
    }

    #[test]
    fn every_error_code_is_decoded_from_a_response() {
        for code in [
            ErrorCode::InvalidConfiguration,
            ErrorCode::ReadbackMismatch,
            ErrorCode::NotUefi,
            ErrorCode::Io,
            ErrorCode::BadRequest,
        ] {
            let input = scripted_response(ResponseLine {
                id: Some(1),
                ok: false,
                error: Some(ErrorBody {
                    code,
                    message: "message".into(),
                }),
            });
            let mut connection = Connection::open(Cursor::new(input), Vec::new()).unwrap();
            assert!(connection.call(Request::DeleteConfiguration).is_err());
        }
    }

    #[test]
    fn overlong_line_is_refused_after_at_most_limit_plus_one_bytes() {
        let mut cursor = Cursor::new(vec![b'x'; protocol::MAX_LINE_BYTES * 2]);
        assert!(matches!(
            Connection::open(&mut cursor, Vec::new()),
            Err(BackendError::Elevation(_))
        ));
        assert_eq!(cursor.position(), (protocol::MAX_LINE_BYTES + 1) as u64);
    }
}
