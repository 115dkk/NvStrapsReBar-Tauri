# Legacy firmware patch catalog

These rule files are a verbatim data mirror of the official ReBarUEFI
`UEFIPatch` catalog at upstream commit
`9c80fdb2cd3db94bdd19c58bd00d5ecf822f6430`.

Upstream source: <https://github.com/xCuri0/ReBarUEFI/tree/9c80fdb2cd3db94bdd19c58bd00d5ecf822f6430/UEFIPatch>

The catalog is not an instruction to apply every rule. A deployment profile
must select each rule explicitly, pin the exact input firmware SHA-256, require
the expected match count, and record the output SHA-256. The X79 rule remains
commented out upstream because it is untested on multi-socket systems. Rules
that mention DSDT changes require separate manual evidence before deployment.

Do not replace a vendor signature, bypass capsule verification, or flash an
artifact merely because a byte pattern matches. Firmware recovery must be
tested and documented first.
