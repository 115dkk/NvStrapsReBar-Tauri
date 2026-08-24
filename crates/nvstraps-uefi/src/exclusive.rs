use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Busy;

/// Serializes mutable access without requiring an allocator or firmware lock.
/// Reentrant callbacks fail closed instead of creating aliased `&mut` values.
pub(crate) struct ExclusiveCell<T> {
    occupied: AtomicBool,
    value: UnsafeCell<T>,
}

impl<T> ExclusiveCell<T> {
    pub(crate) const fn new(value: T) -> Self {
        Self {
            occupied: AtomicBool::new(false),
            value: UnsafeCell::new(value),
        }
    }

    pub(crate) fn try_with<R>(&self, operation: impl FnOnce(&mut T) -> R) -> Result<R, Busy> {
        self.occupied
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| Busy)?;
        let _release = ReleaseOnDrop(&self.occupied);
        // SAFETY: The atomic claim admits exactly one mutable accessor. The
        // closure cannot return a reference tied to this temporary borrow.
        Ok(operation(unsafe { &mut *self.value.get() }))
    }
}

struct ReleaseOnDrop<'cell>(&'cell AtomicBool);

impl Drop for ReleaseOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reentrant_access_is_rejected_without_aliasing() {
        let cell = ExclusiveCell::new(1_u32);

        cell.try_with(|value| {
            assert_eq!(cell.try_with(|_| ()), Err(Busy));
            *value = 2;
        })
        .unwrap();
        assert_eq!(cell.try_with(|value| *value).unwrap(), 2);
    }

    #[test]
    fn a_panicking_operation_releases_the_claim() {
        let cell = ExclusiveCell::new(1_u32);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = cell.try_with::<()>(|_| panic!("injected callback panic"));
        }));

        assert!(result.is_err());
        assert_eq!(cell.try_with(|value| *value).unwrap(), 1);
    }
}
