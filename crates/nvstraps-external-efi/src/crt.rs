/// Compiler-generated calls use the UEFI target's 16-bit wchar_t ABI.
///
/// # Safety
/// `text` must point to a readable, NUL-terminated array of u16 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wcslen(text: *const u16) -> usize {
    let mut length = 0;
    // SAFETY: the caller provides a complete terminated UTF-16 string. Volatile
    // reads prevent LLVM from replacing this implementation with itself.
    while unsafe { text.add(length).read_volatile() } != 0 {
        length += 1;
    }
    length
}
