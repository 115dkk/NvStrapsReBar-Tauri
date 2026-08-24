use core::mem::{self, align_of, size_of};
use core::ptr::NonNull;
use core::slice;

use uefi::Status;
use uefi::boot::{self, MemoryType};

const UEFI_POOL_ALIGNMENT: usize = 8;

struct PoolAllocation {
    pointer: NonNull<u8>,
}

impl PoolAllocation {
    fn for_array<T>(count: usize) -> Result<Self, Status> {
        if count == 0 || size_of::<T>() == 0 || align_of::<T>() > UEFI_POOL_ALIGNMENT {
            return Err(Status::BAD_BUFFER_SIZE);
        }
        let bytes = count
            .checked_mul(size_of::<T>())
            .ok_or(Status::BAD_BUFFER_SIZE)?;
        let pointer = boot::allocate_pool(MemoryType::BOOT_SERVICES_DATA, bytes)
            .map_err(|error| error.status())?;
        Ok(Self { pointer })
    }

    fn cast<T>(&self) -> NonNull<T> {
        self.pointer.cast()
    }
}

impl Drop for PoolAllocation {
    fn drop(&mut self) {
        // SAFETY: This is the unique owner of the matching UEFI pool allocation.
        let _ = unsafe { boot::free_pool(self.pointer) };
    }
}

/// A no-allocator vector whose initialized prefix is tracked by construction.
pub(crate) struct PoolVec<T> {
    _allocation: PoolAllocation,
    pointer: NonNull<T>,
    len: usize,
    capacity: usize,
}

impl<T> PoolVec<T> {
    pub(crate) fn with_capacity(capacity: usize) -> Result<Self, Status> {
        let allocation = PoolAllocation::for_array::<T>(capacity)?;
        let pointer: NonNull<T> = allocation.cast();
        Ok(Self {
            _allocation: allocation,
            pointer,
            len: 0,
            capacity,
        })
    }

    pub(crate) fn push(&mut self, value: T) -> Result<(), Status> {
        if self.len == self.capacity {
            return Err(Status::OUT_OF_RESOURCES);
        }
        // SAFETY: len is below capacity and this slot has not been initialized.
        unsafe { self.pointer.as_ptr().add(self.len).write(value) };
        self.len += 1;
        Ok(())
    }

    pub(crate) fn as_slice(&self) -> &[T] {
        // SAFETY: Only the initialized prefix is exposed and the allocation
        // remains owned for the returned lifetime.
        unsafe { slice::from_raw_parts(self.pointer.as_ptr(), self.len) }
    }

    pub(crate) fn as_mut_slice(&mut self) -> &mut [T] {
        // SAFETY: This owner has exclusive access to the initialized prefix.
        unsafe { slice::from_raw_parts_mut(self.pointer.as_ptr(), self.len) }
    }

    pub(crate) const fn len(&self) -> usize {
        self.len
    }
}

#[allow(
    private_bounds,
    reason = "the private bound seals the all-zero validity invariant inside this Module"
)]
impl<T: ZeroValid> PoolVec<T> {
    pub(crate) fn zeroed(len: usize) -> Result<Self, Status> {
        let mut values = Self::with_capacity(len)?;
        // SAFETY: ZeroValid is private and implemented only for primitive types
        // whose all-zero representation is initialized and valid.
        unsafe { values.pointer.as_ptr().write_bytes(0, len) };
        values.len = len;
        Ok(values)
    }

    pub(crate) fn grow_zeroed(&mut self, new_len: usize) -> Result<(), Status> {
        if new_len <= self.len {
            return Err(Status::BAD_BUFFER_SIZE);
        }
        let mut replacement = Self::zeroed(new_len)?;
        replacement.as_mut_slice()[..self.len].copy_from_slice(self.as_slice());
        mem::swap(self, &mut replacement);
        Ok(())
    }
}

impl<T> Drop for PoolVec<T> {
    fn drop(&mut self) {
        while self.len != 0 {
            self.len -= 1;
            // SAFETY: Every slot below len was initialized exactly once.
            unsafe { self.pointer.as_ptr().add(self.len).drop_in_place() };
        }
        // allocation is freed after initialized values are dropped.
    }
}

trait ZeroValid: Copy {}
impl ZeroValid for u8 {}
impl ZeroValid for u16 {}

/// A single initialized value owned by UEFI pool memory.
pub(crate) struct PoolBox<T> {
    _allocation: PoolAllocation,
    pointer: NonNull<T>,
}

impl<T> PoolBox<T> {
    pub(crate) fn new(value: T) -> Result<Self, Status> {
        let allocation = PoolAllocation::for_array::<T>(1)?;
        let pointer: NonNull<T> = allocation.cast();
        // SAFETY: The exact-sized allocation is uninitialized and uniquely owned.
        unsafe { pointer.as_ptr().write(value) };
        Ok(Self {
            _allocation: allocation,
            pointer,
        })
    }

    pub(crate) fn get_mut(&mut self) -> &mut T {
        // SAFETY: The value is initialized and this owner is exclusively borrowed.
        unsafe { self.pointer.as_mut() }
    }

    pub(crate) fn leak(self) -> NonNull<T> {
        let pointer = self.pointer;
        mem::forget(self);
        pointer
    }
}

impl<T> Drop for PoolBox<T> {
    fn drop(&mut self) {
        // SAFETY: new initialized this value exactly once and it has not moved.
        unsafe { self.pointer.as_ptr().drop_in_place() };
        // allocation is freed after the value is dropped.
    }
}
