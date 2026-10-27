# NvStrapsReBar Secure Boot certificate

`NvStrapsReBar-db.cer` (DER) and `NvStrapsReBar-db.pem` are the public certificate the Release workflow
signs `NvStrapsDiagnostic.efi` and `NvStrapsLoader.efi` with. Adding it to the firmware's allow list
(`db`) lets those two programs run with Secure Boot on; nothing else trusts it.

- Subject: `CN=NvStrapsReBar UEFI db signing 2026, O=NvStrapsReBar project`
- RSA-2048, SHA-256, code signing only, valid until 2046-10-22
- SHA-256 fingerprint: `2DCB22B1BC729D381B2B9071FEF99D38E279C12292F8D3B5ED21EF2A3401A744`

The private key is not in this repository; it exists only as a GitHub Actions secret.

The app saves the `.cer` file to a USB drive and shows the BIOS menu path. In short: BIOS setup →
Secure Boot → Key Management → Authorized Signatures (db) → **Append** → `NvStrapsReBar-db.cer` →
Public Key Certificate. Never use "Set New" or clear the keys: that removes Microsoft's keys too.
See [EXTERNAL_EFI.md](../docs/EXTERNAL_EFI.md#secure-boot).
