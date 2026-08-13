use crate::{DeploymentPlan, DeploymentStore, MachineProfile, StepId, StoreError};

/// Owns validated, append-only Deployment Plan transitions for one Machine Profile.
///
/// Callers may inspect the current plan, but evidence is recorded through this module so a plan
/// is never observed at a new revision unless that exact revision was durably stored.
pub struct DeploymentWorkflow<'a> {
    store: &'a DeploymentStore,
    profile: &'a MachineProfile,
    plan: DeploymentPlan,
}

impl<'a> DeploymentWorkflow<'a> {
    pub fn from_plan(
        store: &'a DeploymentStore,
        profile: &'a MachineProfile,
        plan: DeploymentPlan,
    ) -> Result<Self, StoreError> {
        plan.validate_for(profile)?;
        Ok(Self {
            store,
            profile,
            plan,
        })
    }

    pub fn plan(&self) -> &DeploymentPlan {
        &self.plan
    }

    pub fn into_plan(self) -> DeploymentPlan {
        self.plan
    }

    pub fn record_step(
        &mut self,
        step_id: StepId,
        value: impl Into<String>,
    ) -> Result<(), StoreError> {
        let mut next = self.plan.clone();
        next.complete_with_value(step_id, value)?;
        self.store.save_plan(self.profile, &next)?;
        self.plan = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::{
        BoardPath, FirmwareFingerprint, FirmwareInstallMethod, FirmwareInstallRoute,
        GpuFingerprint, MachineIdentity, PciLocation, RecoveryCapability, RecoveryMethod,
        Sha256Digest,
    };

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "nvstraps-workflow-{}-{nonce}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            assert!(self.0.starts_with(std::env::temp_dir()));
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn profile() -> MachineProfile {
        MachineProfile::create(
            "workflow test",
            BoardPath::NativeResizableBar,
            MachineIdentity {
                board_manufacturer: "Board vendor".into(),
                board_product: "Board product".into(),
                board_version: "1".into(),
                bios_vendor: "BIOS vendor".into(),
                bios_version: "2".into(),
                bios_release_date: "2026-08-14".into(),
                gpus: vec![GpuFingerprint {
                    vendor_id: 0x10de,
                    device_id: 0x1e81,
                    subsystem_vendor_id: 0x1462,
                    subsystem_device_id: 0x3755,
                    location: PciLocation {
                        bus: 1,
                        device: 0,
                        function: 0,
                    },
                    bridge_location: PciLocation {
                        bus: 0,
                        device: 1,
                        function: 0,
                    },
                    bar0_base: 0x8000_0000,
                    bar0_top: 0x80ff_ffff,
                }],
            },
            FirmwareFingerprint {
                file_name: "vendor.bin".into(),
                byte_length: 4,
                sha256: Sha256Digest::from_bytes(b"test"),
            },
            RecoveryCapability {
                method: RecoveryMethod::UsbFlashback,
                tested_or_documented: true,
                note: "documented recovery".into(),
            },
            FirmwareInstallRoute {
                method: FirmwareInstallMethod::FirmwareSetupUtility,
                artifact_file_name: "vendor.bin".into(),
                tested_or_documented: true,
                official_instructions_url: "https://vendor.invalid/manual".into(),
                note: "documented install".into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn evidence_becomes_visible_only_after_the_revision_is_stored() {
        let directory = TestDirectory::new();
        let store = DeploymentStore::new(directory.0.join("store"));
        let profile = profile();
        store.save_profile(&profile).unwrap();
        let plan = DeploymentPlan::for_profile(&profile).unwrap();
        store.save_plan(&profile, &plan).unwrap();
        let mut workflow = DeploymentWorkflow::from_plan(&store, &profile, plan).unwrap();

        workflow
            .record_step(StepId::VerifyProfile, profile.profile_id.clone())
            .unwrap();

        assert_eq!(workflow.plan().revision, 1);
        assert!(workflow.plan().is_step_completed(StepId::VerifyProfile));
        assert_eq!(store.load_plan(&profile).unwrap(), *workflow.plan());
    }

    #[test]
    fn failed_revision_storage_does_not_advance_the_observed_plan() {
        let directory = TestDirectory::new();
        let blocked_root = directory.0.join("not-a-directory");
        fs::write(&blocked_root, b"file blocks store directories").unwrap();
        let store = DeploymentStore::new(blocked_root);
        let profile = profile();
        let plan = DeploymentPlan::for_profile(&profile).unwrap();
        let mut workflow = DeploymentWorkflow::from_plan(&store, &profile, plan).unwrap();

        assert!(
            workflow
                .record_step(StepId::VerifyProfile, profile.profile_id.clone())
                .is_err()
        );
        assert_eq!(workflow.plan().revision, 0);
        assert!(!workflow.plan().is_step_completed(StepId::VerifyProfile));
    }
}
