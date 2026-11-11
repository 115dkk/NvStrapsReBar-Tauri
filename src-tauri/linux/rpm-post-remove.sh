#!/bin/sh
# The .rpm lists the files under /usr/lib/nvstraps-rebar/external but not that directory, so
# removing the package left it behind, and its parent with it (seen with dnf on Fedora 45).
# rpm passes 0 when the package is removed and 1 when it is upgraded.
if [ "$1" = "0" ]; then
	rmdir /usr/lib/nvstraps-rebar/external /usr/lib/nvstraps-rebar 2>/dev/null || :
fi
