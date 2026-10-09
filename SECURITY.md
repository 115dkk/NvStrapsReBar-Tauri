# Security Policy

NvStrapsReBar-Tauri is a personal project maintained by
[@115dkk](https://github.com/115dkk), who is responsible for its security and
handles every vulnerability report for it.

## Scope

- The NvStrapsReBar UEFI DXE driver. It runs at boot, before the operating
  system, with full access to the platform, so a flaw in it takes effect
  before Windows and its protections start.
- The BIOS image tooling that inserts the driver, checks the result, and
  writes the USB package.
- The Windows app, which runs as administrator to read and write the
  driver's UEFI variable, and its installer.
- The workflows in this repository that build the release files.

Flaws that exist only in terminatorul's original C/C++ NvStrapsReBar belong
to that project. Motherboard firmware and vendor flashing tools are not in
scope; report those to the vendor.

## Supported versions

Only the newest stable release, the one GitHub marks as **Latest** on the
[releases page](https://github.com/115dkk/NvStrapsReBar-Tauri/releases),
gets security fixes. The pre-releases published for every `master` commit are
development builds and are not supported. Update first and check whether the
problem is still there.

## Reporting a vulnerability

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/115dkk/NvStrapsReBar-Tauri/security/advisories/new).
Do not open a public issue, discussion, or pull request for a suspected
vulnerability.

A useful report names the release, the motherboard model and BIOS version,
the GPU, the affected component, and the steps that reproduce the problem.
Do not attach a BIOS image you are not allowed to share.

## What happens next

This project is maintained in spare time, so there is no guaranteed response
time. The maintainer reads every report and answers in the report's private
thread. A confirmed vulnerability is fixed in a new release, and the
maintainer then publishes a GitHub security advisory that credits the reporter
unless the reporter asks not to be named.

There is no bug bounty.
