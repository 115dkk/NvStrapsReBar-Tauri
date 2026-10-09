//! The code the firmware jumps to after the S3 resume.
//!
//! The probe publishes it through `FACS.XFirmwareWakingVector`, so EDK2's `S3Resume2Pei` enters it
//! the way the ACPI specification defines for a 32-bit waking vector: protected mode, paging off,
//! flat code and data segments, interrupts disabled, a valid stack. OVMF built with an X64 PEI
//! phase cannot reach a 16-bit real-mode vector from QEMU's TCG: its transition code lives above
//! 1 MiB and faults as soon as the instruction pointer is truncated to 16 bits, so the legacy
//! `FirmwareWakingVector` stays zero.
//!
//! The stub is position independent. It prints one line on the ISA COM1 UART that QEMU maps to
//! the serial log, then asks the chipset for S5 so QEMU exits with a guest shutdown.

use core::fmt;

/// Offset of the 16-bit PM1a control port inside `mov dx, imm16`.
pub const PM1A_PORT_PATCH_OFFSET: usize = 41;
/// Offset of the 16-bit `SLP_TYP | SLP_EN` word inside `mov ax, imm16`.
pub const S5_VALUE_PATCH_OFFSET: usize = 45;
/// Offset of the NUL-terminated message the stub prints.
pub const MESSAGE_OFFSET: usize = 52;

#[cfg(test)]
const COM1_DATA: u16 = 0x03F8;
#[cfg(test)]
const COM1_LINE_STATUS: u16 = 0x03FD;
#[cfg(test)]
const UART_TRANSMIT_HOLDING_EMPTY: u8 = 0x20;

const STUB_TEMPLATE: [u8; 80] = [
    0xfa, // cli
    0xfc, // cld
    0xe8, 0x00, 0x00, 0x00, 0x00, // call next ; pushes the address of `next`
    0x5e, // next: pop esi
    0x81, 0xc6, 0x2d, 0x00, 0x00, 0x00, // add esi, MESSAGE_OFFSET - 7
    0xac, // loop: lodsb
    0x84, 0xc0, // test al, al
    0x74, 0x14, // jz done
    0x88, 0xc3, // mov bl, al
    0x66, 0xba, 0xfd, 0x03, // wait: mov dx, COM1_LINE_STATUS
    0xec, // in al, dx
    0xa8, 0x20, // test al, UART_TRANSMIT_HOLDING_EMPTY
    0x74, 0xf7, // jz wait
    0x66, 0xba, 0xf8, 0x03, // mov dx, COM1_DATA
    0x88, 0xd8, // mov al, bl
    0xee, // out dx, al
    0xeb, 0xe7, // jmp loop
    0x66, 0xba, 0x00, 0x00, // done: mov dx, <PM1a control port>
    0x66, 0xb8, 0x00, 0x00, // mov ax, <S5 SLP_TYP | SLP_EN>
    0x66, 0xef, // out dx, ax
    0xf4, // halt: hlt
    0xeb, 0xfd, // jmp halt
    b'S', b'3', b'-', b'P', b'R', b'O', b'B', b'E', b':', b' ', b'r', b'e', b's', b'u', b'm', b'e',
    b'd', b' ', b'f', b'r', b'o', b'm', b' ', b'S', b'3', b'\r', b'\n', 0,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    SleepTypeOutOfRange(u8),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SleepTypeOutOfRange(value) => {
                write!(
                    formatter,
                    "S5 sleep type {value} does not fit the PM1 control field"
                )
            }
        }
    }
}

/// Builds the stub for the PM1a control port and S5 sleep type the FADT and DSDT describe.
pub fn build(pm1a_port: u16, slp_typ_s5: u8) -> Result<[u8; STUB_TEMPLATE.len()], Error> {
    if slp_typ_s5 > 7 {
        return Err(Error::SleepTypeOutOfRange(slp_typ_s5));
    }
    let mut stub = STUB_TEMPLATE;
    stub[PM1A_PORT_PATCH_OFFSET..PM1A_PORT_PATCH_OFFSET + 2]
        .copy_from_slice(&pm1a_port.to_le_bytes());
    let sleep_value = (u16::from(slp_typ_s5) << 10) | 0x2000;
    stub[S5_VALUE_PATCH_OFFSET..S5_VALUE_PATCH_OFFSET + 2]
        .copy_from_slice(&sleep_value.to_le_bytes());
    Ok(stub)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_and_patch_sites_are_pinned() {
        assert!(STUB_TEMPLATE.len() < 4096);
        assert_eq!(STUB_TEMPLATE.len(), 80);
        assert_eq!(
            &STUB_TEMPLATE[PM1A_PORT_PATCH_OFFSET - 2..PM1A_PORT_PATCH_OFFSET],
            &[0x66, 0xba]
        );
        assert_eq!(
            &STUB_TEMPLATE[PM1A_PORT_PATCH_OFFSET..PM1A_PORT_PATCH_OFFSET + 2],
            &[0, 0]
        );
        assert_eq!(
            &STUB_TEMPLATE[S5_VALUE_PATCH_OFFSET - 2..S5_VALUE_PATCH_OFFSET],
            &[0x66, 0xb8]
        );
        assert_eq!(
            &STUB_TEMPLATE[S5_VALUE_PATCH_OFFSET..S5_VALUE_PATCH_OFFSET + 2],
            &[0, 0]
        );
        assert_eq!(
            &STUB_TEMPLATE[MESSAGE_OFFSET..],
            b"S3-PROBE: resumed from S3\r\n\0"
        );
    }

    #[test]
    fn message_pointer_and_branches_land_where_the_listing_says() {
        // `call next` is five bytes from offset 2, so `pop esi` yields the address of offset 7.
        let message_displacement = u32::from_le_bytes(STUB_TEMPLATE[10..14].try_into().unwrap());
        assert_eq!(message_displacement as usize, MESSAGE_OFFSET - 7);
        // `jz done` at 17 skips to the `mov dx` that starts the shutdown sequence.
        assert_eq!(
            19 + usize::from(STUB_TEMPLATE[18]),
            PM1A_PORT_PATCH_OFFSET - 2
        );
        // `jz wait` at 28 returns to the line-status read at 21.
        assert_eq!(30_i32 + i32::from(STUB_TEMPLATE[29] as i8), 21);
        // `jmp loop` at 37 returns to `lodsb` at 14.
        assert_eq!(39_i32 + i32::from(STUB_TEMPLATE[38] as i8), 14);
        // `jmp halt` at 50 returns to `hlt` at 49.
        assert_eq!(52_i32 + i32::from(STUB_TEMPLATE[51] as i8), 49);
        assert_eq!(
            u16::from_le_bytes(STUB_TEMPLATE[23..25].try_into().unwrap()),
            COM1_LINE_STATUS
        );
        assert_eq!(STUB_TEMPLATE[27], UART_TRANSMIT_HOLDING_EMPTY);
        assert_eq!(
            u16::from_le_bytes(STUB_TEMPLATE[32..34].try_into().unwrap()),
            COM1_DATA
        );
    }

    #[test]
    fn patches_port_and_s5_value() {
        let stub = build(0x604, 1).unwrap();
        assert_eq!(
            &stub[PM1A_PORT_PATCH_OFFSET..PM1A_PORT_PATCH_OFFSET + 2],
            &[0x04, 0x06]
        );
        assert_eq!(
            &stub[S5_VALUE_PATCH_OFFSET..S5_VALUE_PATCH_OFFSET + 2],
            &[0x00, 0x24]
        );
        assert_eq!(build(0x604, 0).unwrap()[S5_VALUE_PATCH_OFFSET + 1], 0x20);
        assert_eq!(build(0x604, 8), Err(Error::SleepTypeOutOfRange(8)));
    }
}
