use std::collections::BTreeMap;

use crate::execution::{
    DeviceTransaction, ExecutionFault, FirmwareExecutionAdapter, StrapProgramReceipt,
};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ExecutionAction {
    RemapBridge,
    RemapDeviceBar0,
    ProgramBar1Straps,
    RestoreDeviceBar0,
    RestoreBridge,
}

/// Host-side Adapter for deterministic sequencing and fault-injection tests.
#[derive(Debug)]
pub struct SimulationAdapter {
    actions: Vec<ExecutionAction>,
    failures: BTreeMap<ExecutionAction, ExecutionFault>,
    reported_changed: bool,
    resume_fault: Option<ExecutionFault>,
}

impl Default for SimulationAdapter {
    fn default() -> Self {
        Self {
            actions: Vec::new(),
            failures: BTreeMap::new(),
            reported_changed: true,
            resume_fault: None,
        }
    }
}

impl SimulationAdapter {
    pub fn fail(mut self, action: ExecutionAction, failure: ExecutionFault) -> Self {
        self.failures.insert(action, failure);
        self
    }

    pub const fn with_resume_fault(mut self, failure: ExecutionFault) -> Self {
        self.resume_fault = Some(failure);
        self
    }

    pub const fn with_reported_changed(mut self, reported_changed: bool) -> Self {
        self.reported_changed = reported_changed;
        self
    }

    pub fn actions(&self) -> &[ExecutionAction] {
        &self.actions
    }

    fn perform(&mut self, action: ExecutionAction) -> Result<(), ExecutionFault> {
        self.actions.push(action);
        self.failures.get(&action).copied().map_or(Ok(()), Err)
    }
}

impl FirmwareExecutionAdapter for SimulationAdapter {
    type BridgeState = ();
    type DeviceState = ();

    fn remap_bridge(
        &mut self,
        _request: &DeviceTransaction,
    ) -> Result<Self::BridgeState, ExecutionFault> {
        self.perform(ExecutionAction::RemapBridge)
    }

    fn remap_device_bar0(
        &mut self,
        _request: &DeviceTransaction,
    ) -> Result<Self::DeviceState, ExecutionFault> {
        self.perform(ExecutionAction::RemapDeviceBar0)
    }

    fn program_bar1_straps(
        &mut self,
        _request: &DeviceTransaction,
    ) -> Result<StrapProgramReceipt, ExecutionFault> {
        self.perform(ExecutionAction::ProgramBar1Straps)?;
        Ok(StrapProgramReceipt {
            reported_changed: self.reported_changed,
            resume_fault: self.resume_fault,
        })
    }

    fn restore_device_bar0(
        &mut self,
        _request: &DeviceTransaction,
        _saved: Self::DeviceState,
    ) -> Result<(), ExecutionFault> {
        self.perform(ExecutionAction::RestoreDeviceBar0)
    }

    fn restore_bridge(
        &mut self,
        _request: &DeviceTransaction,
        _saved: Self::BridgeState,
    ) -> Result<(), ExecutionFault> {
        self.perform(ExecutionAction::RestoreBridge)
    }
}
