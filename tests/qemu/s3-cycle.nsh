@echo -off
dmpstore -guid e3ee4a27-e2a2-4435-bba3-184ccad935a8 NvStrapsReBarStatus
fs0:\NvStrapsS3Probe.efi
echo S3-PROBE: did not suspend
reset -s
