pub const IMAGE_SECURITY_DATABASE_GUID: &str = "d719b2cb-3d3a-4596-a3bc-dad00e67656f";

const EFI_CERT_X509: [u8; 16] = [
    0xa1, 0x59, 0xc0, 0xa5, 0xe4, 0x94, 0xa7, 0x4a, 0x87, 0xb5, 0xab, 0x15, 0x5c, 0x2b, 0xf0, 0x72,
];
const EFI_CERT_SHA256: [u8; 16] = [
    0x26, 0x16, 0xc4, 0xc1, 0x4c, 0x50, 0x92, 0x40, 0xac, 0xa9, 0x41, 0xf9, 0x36, 0x93, 0x43, 0x28,
];
const LIST_HEADER_SIZE: usize = 16 + 4 + 4 + 4;
const OWNER_SIZE: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Signature {
    X509(Vec<u8>),
    Sha256([u8; 32]),
    Other,
}

/// Parses the concatenated EFI_SIGNATURE_LIST values stored in a db or dbx variable.
pub fn parse(bytes: &[u8]) -> Result<Vec<Signature>, String> {
    let mut signatures = Vec::new();
    let mut at = 0usize;

    while at < bytes.len() {
        let fixed = bytes
            .get(at..at + LIST_HEADER_SIZE)
            .ok_or("EFI signature-list header is truncated")?;
        let signature_type: [u8; 16] = fixed[..16]
            .try_into()
            .map_err(|_| "EFI signature type is truncated")?;
        let list_size = usize::try_from(u32::from_le_bytes(
            fixed[16..20]
                .try_into()
                .map_err(|_| "EFI signature-list size is truncated")?,
        ))
        .map_err(|_| "EFI signature-list size does not fit in memory")?;
        let header_size = usize::try_from(u32::from_le_bytes(
            fixed[20..24]
                .try_into()
                .map_err(|_| "EFI signature-header size is truncated")?,
        ))
        .map_err(|_| "EFI signature-header size does not fit in memory")?;
        let signature_size = usize::try_from(u32::from_le_bytes(
            fixed[24..28]
                .try_into()
                .map_err(|_| "EFI signature size is truncated")?,
        ))
        .map_err(|_| "EFI signature size does not fit in memory")?;

        if list_size < LIST_HEADER_SIZE {
            return Err("EFI signature-list size is smaller than its header".to_owned());
        }
        let list_end = at
            .checked_add(list_size)
            .filter(|end| *end <= bytes.len())
            .ok_or("EFI signature list exceeds the input")?;
        let entries_at = at
            .checked_add(LIST_HEADER_SIZE)
            .and_then(|value| value.checked_add(header_size))
            .filter(|value| *value <= list_end)
            .ok_or("EFI signature header exceeds its list")?;
        if signature_size < OWNER_SIZE {
            return Err("EFI signature size is smaller than its owner GUID".to_owned());
        }
        let entries_len = list_end - entries_at;
        if !entries_len.is_multiple_of(signature_size) {
            return Err("EFI signature entries do not fit their declared size".to_owned());
        }

        if signature_type == EFI_CERT_SHA256 && signature_size != OWNER_SIZE + 32 {
            return Err("EFI SHA-256 signature has the wrong size".to_owned());
        }

        for entry in bytes[entries_at..list_end].chunks_exact(signature_size) {
            let data = &entry[OWNER_SIZE..];
            if signature_type == EFI_CERT_X509 {
                signatures.push(Signature::X509(data.to_vec()));
            } else if signature_type == EFI_CERT_SHA256 {
                signatures.push(Signature::Sha256(
                    data.try_into()
                        .map_err(|_| "EFI SHA-256 signature has the wrong size")?,
                ));
            } else {
                signatures.push(Signature::Other);
            }
        }

        at = list_end;
    }

    Ok(signatures)
}

/// Reports whether db contains the certificate or every supplied image digest.
pub fn trusts(db: &[u8], certificate_der: &[u8], image_digests: &[[u8; 32]]) -> bool {
    let Ok(signatures) = parse(db) else {
        return false;
    };
    if signatures
        .iter()
        .any(|signature| matches!(signature, Signature::X509(value) if value == certificate_der))
    {
        return true;
    }
    !image_digests.is_empty()
        && image_digests.iter().all(|digest| {
            signatures
                .iter()
                .any(|signature| matches!(signature, Signature::Sha256(value) if value == digest))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: [u8; 16] = [0x55; 16];
    const OTHER_GUID: [u8; 16] = [0x11; 16];

    fn list(signature_type: [u8; 16], header: &[u8], entries: &[Vec<u8>]) -> Vec<u8> {
        let signature_size = entries.first().map_or(OWNER_SIZE, |entry| {
            assert!(entries.iter().all(|other| other.len() == entry.len()));
            OWNER_SIZE + entry.len()
        });
        let list_size = LIST_HEADER_SIZE + header.len() + entries.len() * signature_size;
        let mut bytes = Vec::with_capacity(list_size);
        bytes.extend_from_slice(&signature_type);
        bytes.extend_from_slice(&u32::try_from(list_size).unwrap().to_le_bytes());
        bytes.extend_from_slice(&u32::try_from(header.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(&u32::try_from(signature_size).unwrap().to_le_bytes());
        bytes.extend_from_slice(header);
        for entry in entries {
            bytes.extend_from_slice(&OWNER);
            bytes.extend_from_slice(entry);
        }
        bytes
    }

    #[test]
    fn parses_x509_sha256_other_and_multiple_lists() {
        let certificate = vec![0x30, 3, 1, 2, 3];
        let digest = [0x6a; 32];
        let mut db = list(EFI_CERT_X509, &[9, 8], std::slice::from_ref(&certificate));
        db.extend_from_slice(&list(EFI_CERT_SHA256, &[], &[digest.to_vec()]));
        db.extend_from_slice(&list(OTHER_GUID, &[], &[vec![1, 2, 3, 4]]));
        assert_eq!(
            parse(&db).unwrap(),
            vec![
                Signature::X509(certificate),
                Signature::Sha256(digest),
                Signature::Other
            ]
        );
    }

    #[test]
    fn rejects_truncated_and_inconsistent_sizes_without_panicking() {
        let valid = list(EFI_CERT_SHA256, &[], &[vec![7; 32]]);
        for length in 1..valid.len() {
            assert!(parse(&valid[..length]).is_err(), "accepted length {length}");
        }

        let mut too_small_list = valid.clone();
        too_small_list[16..20].copy_from_slice(&27_u32.to_le_bytes());
        assert!(parse(&too_small_list).is_err());

        let mut excessive_header = valid.clone();
        excessive_header[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse(&excessive_header).is_err());

        let mut zero_signature = valid.clone();
        zero_signature[24..28].copy_from_slice(&0_u32.to_le_bytes());
        assert!(parse(&zero_signature).is_err());

        let mut wrong_sha_size = valid;
        wrong_sha_size[24..28].copy_from_slice(&47_u32.to_le_bytes());
        assert!(parse(&wrong_sha_size).is_err());
    }

    #[test]
    fn trust_accepts_the_certificate_or_all_digests_but_not_some() {
        let certificate = b"certificate".to_vec();
        let digest_a = [0x11; 32];
        let digest_b = [0x22; 32];
        let by_certificate = list(EFI_CERT_X509, &[], std::slice::from_ref(&certificate));
        assert!(trusts(&by_certificate, &certificate, &[digest_a, digest_b]));

        let all_digests = list(
            EFI_CERT_SHA256,
            &[],
            &[digest_a.to_vec(), digest_b.to_vec()],
        );
        assert!(trusts(
            &all_digests,
            b"different certificate",
            &[digest_a, digest_b]
        ));
        assert!(!trusts(
            &list(EFI_CERT_SHA256, &[], &[digest_a.to_vec()]),
            b"different certificate",
            &[digest_a, digest_b]
        ));
        assert!(!trusts(&all_digests, b"different certificate", &[]));
        assert!(!trusts(&all_digests[..20], &certificate, &[digest_a]));
    }
}
