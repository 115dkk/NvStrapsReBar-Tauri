#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import net from "node:net";

function fail(message) {
  process.stderr.write(`qemu-s3-wakeup: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("usage: --socket <path> --events <path> --timeout-seconds <n>");
    }
    options[key.slice(2)] = value;
  }
  const timeout = Number(options["timeout-seconds"]);
  if (!options.socket || !options.events || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("usage: --socket <path> --events <path> --timeout-seconds <n>");
  }
  return { socket: options.socket, events: options.events, timeout };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error.message);
  process.exit();
}
writeFileSync(options.events, "");

const deadline = Date.now() + options.timeout * 1000;
let socket;
let buffer = "";
let sawSuspend = false;
let sawWakeup = false;
let finished = false;

const timer = setInterval(() => {
  if (finished) return;
  if (Date.now() >= deadline) {
    finished = true;
    socket?.destroy();
    clearInterval(timer);
    fail("timed out waiting for the S3 event sequence");
    return;
  }
  if (!socket && existsSync(options.socket)) connect();
}, 100);

function connect() {
  socket = net.createConnection(options.socket);
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      appendFileSync(options.events, `${line}\n`);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        finishError("QMP returned invalid JSON");
        return;
      }
      handleMessage(message);
    }
  });
  socket.on("error", (error) => finishError(`socket error: ${error.message}`));
  socket.on("close", () => {
    if (!finished) finishError("QMP socket closed before guest shutdown");
  });
}

function send(command) {
  socket.write(`${JSON.stringify({ execute: command })}\n`);
}

function handleMessage(message) {
  if (message.QMP) {
    send("qmp_capabilities");
    return;
  }
  if (message.event === "RESET") {
    finishError("unexpected RESET event");
  } else if (message.event === "SUSPEND") {
    sawSuspend = true;
    setTimeout(() => {
      if (!finished) send("system_wakeup");
    }, 1000);
  } else if (message.event === "WAKEUP") {
    sawWakeup = true;
  } else if (message.event === "SHUTDOWN") {
    const guestShutdown =
      message.data?.guest === true && message.data?.reason === "guest-shutdown";
    if (!guestShutdown) {
      finishError(`unexpected SHUTDOWN event: ${JSON.stringify(message.data)}`);
    } else if (!sawSuspend || !sawWakeup) {
      finishError("guest shutdown arrived before complete SUSPEND/WAKEUP sequence");
    } else {
      finished = true;
      clearInterval(timer);
      socket.end();
      process.stdout.write("QMP S3 sequence: SUSPEND, WAKEUP, guest shutdown\n");
    }
  }
}

function finishError(message) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  socket?.destroy();
  fail(message);
}
