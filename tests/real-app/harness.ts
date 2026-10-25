import { chromium, expect, test as base, type Browser, type Page, type TestInfo } from "@playwright/test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { advanceBoot, initialMachine, readMachine, writeMachine, type BoardIdentity, type RebootKind } from "./machine";

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dataName = "io.github.nvstrapsrebar.simulated";
const localData = process.env.LOCALAPPDATA;
if (!localData) throw new Error("LOCALAPPDATA is required for real-app journeys");
const dataDirectory = join(localData, dataName);
const panicPath = join(dataDirectory, "logs", "panic.log");
export const runFile = promisify(execFile);

/** For a launch that never reached the page: the WebView2 command lines show whether the debugging port arrived. */
async function processList() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'NvStrapsReBar|msedgewebview2|WerFault' } | ForEach-Object { \"$($_.ProcessId) $($_.Name) $($_.CommandLine)\" }";
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-Command", script], { maxBuffer: 4 * 1024 * 1024 }).catch(error => ({ stdout: `(process list unavailable: ${String(error)})` }));
  return `Processes:\n${stdout.trim() || "(no NvStrapsReBar, msedgewebview2 or WerFault process)"}`;
}

export const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
export const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local CDP port allocated");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

// This function is serialized into the WebView. Only the OS folder dialog is replaced; every
// application command still reaches the real backend. Tauri defines `__TAURI_INTERNALS__.invoke`
// as non-writable, so the answer is given one layer down: its IPC script POSTs each command to
// `http://ipc.localhost/<command>` with `fetch` and reads a `Tauri-Response: ok` reply.
function installDialogBridge() {
  const host = window as unknown as {
    __nvstrapsRealDialog?: () => Promise<string>;
    __nvstrapsRealDialogFetch?: typeof fetch;
  };
  localStorage.setItem("nvstraps-rebar.ui.language", "en");
  if (window.fetch === host.__nvstrapsRealDialogFetch) return;
  const dialogUrl = `http://ipc.localhost/${encodeURIComponent("plugin:dialog|open")}`;
  const original = window.fetch.bind(window);
  const bridged: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== dialogUrl) return original(input, init);
    const answer = await host.__nvstrapsRealDialog!();
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
    });
  };
  window.fetch = bridged;
  host.__nvstrapsRealDialogFetch = bridged;
}

export class RealApp {
  page!: Page;
  machineFile!: string;
  exportFolder!: string;
  temporaryDirectory!: string;
  private browser?: Browser;
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private closing = false;
  private dialogAnswers: string[] = [];
  private failure?: Error;
  private signalFailure!: (error: Error) => void;
  private readonly failed = new Promise<Error>(resolve => { this.signalFailure = resolve; });
  private processOutput = "";

  constructor(private readonly info: TestInfo) {}

  private fail(message: string) {
    this.failure ??= new Error(message);
    this.signalFailure(this.failure);
  }

  async initialize(identity: BoardIdentity) {
    expect(basename(dataDirectory)).toBe(dataName);
    expect(isAbsolute(dataDirectory)).toBe(true);
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    const temporaryRoot = resolve(tmpdir());
    const fromRepository = relative(repository, temporaryRoot);
    if (!fromRepository.startsWith("..") && !isAbsolute(fromRepository)) {
      throw new Error("The real-app temporary directory must be outside the repository");
    }
    this.temporaryDirectory = await mkdtemp(join(temporaryRoot, "nvstraps-real-app-"));
    this.machineFile = join(this.temporaryDirectory, "machine.json");
    this.exportFolder = join(this.temporaryDirectory, "usb");
    await mkdir(this.exportFolder);
    await writeMachine(this.machineFile, initialMachine(identity));
  }

  async launch() {
    this.assertHealthy();
    this.closing = false;
    const port = await freePort();
    const executable = resolve(process.env.NVSTRAPS_REAL_APP_EXE ?? join(repository, "target/debug/NvStrapsReBar.exe"));
    const child = spawn(executable, [], {
      cwd: repository,
      env: {
        ...process.env,
        NVSTRAPS_SIMULATED_MACHINE: this.machineFile,
        NVSTRAPS_SIMULATED_DEVTOOLS_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.exited = new Promise(resolve => child.once("close", () => resolve()));
    child.on("error", error => this.fail(`Tauri launch failed: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (!this.closing) this.fail(`Tauri exited unexpectedly: code=${code}, signal=${signal}`);
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", chunk => { this.processOutput = (this.processOutput + String(chunk)).slice(-16_384); });
    }
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    let available = false;
    while (Date.now() < deadline) {
      this.assertHealthy();
      try {
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) { available = true; break; }
      } catch { /* The WebView has not started listening yet. */ }
      await delay(100);
    }
    if (!available) {
      await this.desktopEvidence();
      throw new Error(`Tauri WebView CDP endpoint did not answer within 60 seconds\n${await processList()}`);
    }
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    this.browser = browser;
    browser.on("disconnected", () => {
      if (!this.closing) this.fail("Tauri WebView disconnected unexpectedly");
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error("The Tauri WebView has no CDP context");
    context.setDefaultTimeout(30_000);
    const watchPage = (page: Page) => page.on("pageerror", error => this.fail(`pageerror: ${error.stack ?? error.message}`));
    context.pages().forEach(watchPage);
    context.on("page", watchPage);
    await context.exposeBinding("__nvstrapsRealDialog", async () => {
      const answer = this.dialogAnswers.shift();
      if (answer === undefined) {
        this.fail("The application opened a native dialog without a queued answer");
        throw this.failure;
      }
      return answer;
    });
    await context.addInitScript(installDialogBridge);
    await expect.poll(() => context.pages().some(page => page.url().startsWith("http://tauri.localhost"))).toBe(true);
    this.page = context.pages().find(page => page.url().startsWith("http://tauri.localhost"))!;
    await this.page.evaluate(installDialogBridge);
    await this.page.reload();
    await expect(this.page.locator(".nv-root")).toBeVisible();
    await this.page.evaluate(installDialogBridge);
    await expect.poll(() => this.page.evaluate(() => {
      const host = window as unknown as { __nvstrapsRealDialogFetch?: typeof fetch };
      return window.fetch === host.__nvstrapsRealDialogFetch;
    }), { message: "the native dialog bridge must survive Tauri initialization" }).toBe(true);
    this.assertHealthy();
  }

  /** Without a WebView there is no page to capture; the desktop shows any dialog the app raised. */
  private async desktopEvidence() {
    await mkdir(this.info.outputDir, { recursive: true });
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
      "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen",
      "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
      "[System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
      `$bitmap.Save('${this.info.outputPath("desktop.png").replaceAll("'", "''")}')`,
    ].join("; ");
    await runFile("powershell.exe", ["-NoProfile", "-Command", script]).catch(error => {
      console.error(`Desktop screenshot unavailable: ${String(error)}`);
    });
  }

  queueFolder(folder: string) {
    expect(isAbsolute(folder)).toBe(true);
    this.dialogAnswers.push(folder);
  }

  assertHealthy() {
    if (this.failure) throw this.failure;
  }

  async step<T>(name: string, action: () => Promise<T>): Promise<T> {
    return base.step(name, async () => {
      try {
        this.assertHealthy();
        const result = await Promise.race([
          action(),
          this.failed.then(error => { throw error; }),
        ]);
        this.assertHealthy();
        return result;
      } catch (error) {
        const panic = await readFile(panicPath, "utf8").catch(() => "(no panic.log)");
        throw new Error(`${name}\n${String(error)}\n\npanic.log:\n${panic}\n\nProcess output:\n${this.processOutput}`, { cause: error });
      }
    });
  }

  async reboot(kind: RebootKind) {
    await expect.poll(async () => (await readMachine(this.machineFile)).rebootRequests.map(request => request.kind)).toEqual(
      kind === "firmwareSetup" ? ["firmwareSetup"] : ["firmwareSetup", "configuration"],
    );
    await this.close();
    await advanceBoot(this.machineFile, kind);
    await this.launch();
  }

  async close() {
    this.closing = true;
    try {
      await this.browser?.close(); // CDP close disconnects; the child is terminated below.
    } finally {
      this.browser = undefined;
      const child = this.child;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        // A restart closes windows before it ends processes, which lets WebView2 write its
        // storage. Ask the window to close first and force only an application that hangs.
        await runFile("taskkill.exe", ["/PID", String(child.pid)]).catch(() => undefined);
        const closed = await Promise.race([this.exited?.then(() => true), delay(15_000).then(() => false)]);
        if (!closed) await runFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
      }
      if (this.exited) await this.exited;
      this.child = undefined;
    }
  }

  async failureArtifacts() {
    await mkdir(this.info.outputDir, { recursive: true });
    if (this.page && !this.page.isClosed()) {
      await this.page.screenshot({ path: this.info.outputPath("failure.png"), timeout: 5_000 }).catch(error => {
        console.error(`Failure screenshot unavailable: ${String(error)}`);
      });
    }
    await copyFile(panicPath, this.info.outputPath("panic.log")).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(this.info.outputPath("panic.log"), "No application panic.log was present.\n");
    });
    if (this.machineFile) await copyFile(this.machineFile, this.info.outputPath("machine-file.log"));
    if (this.page && !this.page.isClosed()) {
      console.error(`Screen at failure:\n${await this.page.locator("body").innerText({ timeout: 3_000 }).catch(() => "(unavailable)")}`);
    }
  }

  async dispose() {
    try {
      await this.close();
    } finally {
      if (this.temporaryDirectory) {
        await rm(this.temporaryDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }

  assertDialogsConsumed() {
    expect(this.dialogAnswers).toEqual([]);
  }
}

export const test = base.extend<{ app: RealApp }>({
  app: async ({}, use, info) => {
    const app = new RealApp(info);
    let fixtureFailed = false;
    try {
      await use(app);
      if (info.status === info.expectedStatus) {
        app.assertHealthy();
        app.assertDialogsConsumed();
      }
    } catch (error) {
      fixtureFailed = true;
      throw error;
    } finally {
      try {
        if (fixtureFailed || info.status !== info.expectedStatus) await app.failureArtifacts();
      } finally {
        await app.dispose();
        console.log(`${info.title}: ${(info.duration / 1_000).toFixed(1)}s (${info.status})`);
      }
    }
  },
});
