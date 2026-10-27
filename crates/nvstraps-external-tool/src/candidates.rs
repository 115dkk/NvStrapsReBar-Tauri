use nvstraps_external::{Handoff, PlanError, Slot, Snapshot, make_plan};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SizeOption {
    pub bytes: u64,
    pub error: Option<PlanError>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub slot: Slot,
    pub product: u16,
    pub current_bar1_bytes: u64,
    pub refusal: Option<PlanError>,
    pub sizes: Vec<SizeOption>,
}

/// Evaluates every NVIDIA display controller against all larger supported BAR1 sizes.
pub fn evaluate(snapshot: &Snapshot, handoff: &Handoff) -> Vec<Candidate> {
    snapshot
        .devices
        .iter()
        .filter(|device| device.vendor == 0x10de && device.class >> 16 == 0x03)
        .map(|device| {
            let current_bar1_bytes = device
                .bars
                .iter()
                .find(|bar| bar.index == 1 && bar.memory)
                .and_then(|bar| bar.span.end.checked_sub(bar.span.start))
                .unwrap_or(0);
            let sizes = (29..=35)
                .map(|power| 1_u64 << power)
                .filter(|bytes| *bytes > current_bar1_bytes)
                .map(|bytes| SizeOption {
                    bytes,
                    error: make_plan(snapshot, device.slot, bytes, handoff.clone()).err(),
                })
                .collect::<Vec<_>>();
            let refusal = common_error(&sizes).or_else(|| {
                sizes.is_empty().then(|| {
                    make_plan(snapshot, device.slot, 32_u64 << 30, handoff.clone())
                        .err()
                        .unwrap_or(PlanError::InvalidSize)
                })
            });
            Candidate {
                slot: device.slot,
                product: device.product,
                current_bar1_bytes,
                refusal,
                sizes,
            }
        })
        .collect()
}

fn common_error(sizes: &[SizeOption]) -> Option<PlanError> {
    let first = sizes.first()?.error?;
    sizes
        .iter()
        .all(|option| option.error == Some(first))
        .then_some(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nvstraps_external::{Bar, Device, Environment, Root, SCHEMA, Span};

    fn snapshot() -> Snapshot {
        Snapshot {
            schema: SCHEMA,
            environment: Environment::Physical,
            machine: "machine".to_owned(),
            firmware: "firmware".to_owned(),
            enumeration_complete: true,
            secure_boot: Some(false),
            s3_save_state: false,
            roots: vec![Root {
                segment: 0,
                first_bus: 1,
                last_bus: 1,
                memory: vec![Span {
                    start: 1 << 32,
                    end: 64 << 30,
                }],
            }],
            devices: vec![Device {
                slot: Slot {
                    segment: 0,
                    bus: 1,
                    device: 0,
                    function: 0,
                },
                vendor: 0x10de,
                product: 0x1e81,
                subsystem: 0x14623771,
                class: 0x030000,
                command: 6,
                bars: vec![
                    Bar {
                        index: 0,
                        span: Span {
                            start: 0x8000_0000,
                            end: 0x8100_0000,
                        },
                        memory: true,
                        prefetchable: false,
                        width64: false,
                        raw_low: 0x8000_0000,
                    },
                    Bar {
                        index: 1,
                        span: Span {
                            start: 1 << 32,
                            end: (1 << 32) + (256 << 20),
                        },
                        memory: true,
                        prefetchable: true,
                        width64: true,
                        raw_low: 12,
                    },
                ],
                bridge: None,
                driver_count: 0,
                console: true,
                straps: Some([0x8000_8000, 0x8000_0000]),
            }],
            available_mmio: vec![Span {
                start: 8 << 30,
                end: 64 << 30,
            }],
            errors: Vec::new(),
        }
    }

    #[test]
    fn reports_a_common_console_refusal() {
        let handoff = Handoff {
            path: "\\EFI\\Microsoft\\Boot\\bootmgfw.efi".to_owned(),
            sha256: [1; 32],
        };
        let candidates = evaluate(&snapshot(), &handoff);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].refusal, Some(PlanError::ConsoleInUse));
        assert!(
            candidates[0]
                .sizes
                .iter()
                .all(|size| size.error == Some(PlanError::ConsoleInUse))
        );
    }

    #[test]
    fn real_app_fixture_offers_and_plans_eight_gibibytes() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/real-app/fixtures/external-diagnostic.json");
        let snapshot: Snapshot = serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
        let handoff = Handoff {
            path: nvstraps_external::WINDOWS_BOOT_MANAGER.to_owned(),
            sha256: [0x5a; 32],
        };
        let candidates = evaluate(&snapshot, &handoff);
        assert_eq!(candidates.len(), 1);
        let option = candidates[0]
            .sizes
            .iter()
            .find(|option| option.bytes == 8 << 30)
            .unwrap();
        assert_eq!(option.error, None);
        assert_eq!(candidates[0].refusal, None);
        assert!(make_plan(&snapshot, candidates[0].slot, 8 << 30, handoff).is_ok());
    }
}
