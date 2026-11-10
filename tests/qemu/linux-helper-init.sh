#!/bin/busybox sh
# PID 1 of the initramfs that scripts/qemu-linux-helper.sh boots. It runs the production
# nvstraps-rebar-helper against the kernel's efivarfs and prints what it sees on the serial
# console; the host script compares those lines. The stage comes from the kernel command line.

/bin/busybox --install -s /bin
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t efivarfs efivarfs /sys/firmware/efi/efivars

GUID=e3ee4a27-e2a2-4435-bba3-184ccad935a8
CONFIG=/sys/firmware/efi/efivars/NvStrapsReBar-$GUID
STATUS=/sys/firmware/efi/efivars/NvStrapsReBarStatus-$GUID
echo 'user:x:1000:1000::/:/bin/sh' > /etc/passwd
# SAMPLE_FIRST, SAMPLE_LONGER, SAMPLE_SHORTER and SAMPLE_INVALID, written by the host script.
. /etc/nvstraps-samples

say() { echo "NVSTRAPS-LINUX: $*"; }
dump() { if [ -e "$1" ]; then hexdump -v -e '1/1 "%02x"' "$1"; else printf absent; fi; }
# One helper process per request, as root: prints the helper's answer to that request.
ask() { printf '%s\n' "$1" | /bin/nvstraps-rebar-helper | tail -n 1; }
write() { ask "{\"id\":$1,\"request\":{\"kind\":\"writeConfiguration\",\"dataHex\":\"$2\"}}"; }
remove() { ask "{\"id\":$1,\"request\":{\"kind\":\"deleteConfiguration\"}}"; }

stage=$(sed -n 's/.*nvstraps\.stage=\([0-9]\).*/\1/p' /proc/cmdline)
# The firmware leaves the cursor mid-line; start the report on a line of its own.
echo
say "stage $stage begins: status=$(dump "$STATUS") config=$(dump "$CONFIG")"

case "$stage" in
1)
	say "hello=$(: | /bin/nvstraps-rebar-helper)"
	say "write-first=$(write 1 "$SAMPLE_FIRST")"
	say "config-after-write=$(dump "$CONFIG")"
	say "user-read=$(su user -c "hexdump -v -e '1/1 \"%02x\"' $CONFIG")"
	if su user -c "printf x > $CONFIG" 2>/dev/null; then
		say "user-write=accepted"
	else
		say "user-write=refused"
	fi
	if su user -c "rm -f $CONFIG" 2>/dev/null; then
		say "user-delete=accepted"
	else
		say "user-delete=refused"
	fi
	say "config-after-user-attempts=$(dump "$CONFIG")"
	;;
2)
	# The variable written in stage 1 is immutable now; each of these has to clear that first.
	say "write-longer=$(write 2 "$SAMPLE_LONGER")"
	say "config-after-longer=$(dump "$CONFIG")"
	say "write-shorter=$(write 3 "$SAMPLE_SHORTER")"
	say "config-after-shorter=$(dump "$CONFIG")"
	say "write-invalid=$(write 4 "$SAMPLE_INVALID")"
	say "config-after-invalid=$(dump "$CONFIG")"
	say "delete=$(remove 5)"
	say "config-after-delete=$(dump "$CONFIG")"
	say "delete-again=$(remove 6)"
	say "config-after-delete-again=$(dump "$CONFIG")"
	;;
3) ;;
*)
	say "unknown stage"
	;;
esac

say "stage $stage ends"
poweroff -f
