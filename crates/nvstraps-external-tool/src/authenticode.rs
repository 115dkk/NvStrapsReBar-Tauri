use der::{Decode, Encode};
use sha2::{Digest, Sha256};
use x509_cert::Certificate;

const OID_SIGNED_DATA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
const OID_SHA256: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const OID_RSA_ENCRYPTION: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_CONTENT_TYPE: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03];
const OID_MESSAGE_DIGEST: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04];
const OID_SPC_INDIRECT_DATA: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04];
const OID_SPC_PE_IMAGE_DATA: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x0f];
const OID_SPC_SP_OPUS_INFO: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x0c];

const WIN_CERT_REVISION_2_0: u16 = 0x0200;
const WIN_CERT_TYPE_PKCS_SIGNED_DATA: u16 = 0x0002;

#[derive(Clone, Debug)]
struct PeLayout {
    checksum_at: usize,
    certificate_entry_at: usize,
    size_of_headers: usize,
    sections: Vec<(usize, usize)>,
    certificate_table: Option<(usize, usize)>,
}

/// Values prepared before an external process makes the RSA signature.
pub struct Prepared {
    image: Vec<u8>,
    certificate_der: Vec<u8>,
    issuer_der: Vec<u8>,
    serial_der: Vec<u8>,
    spc_indirect_data: Vec<u8>,
    signed_attributes: Vec<u8>,
}

impl Prepared {
    /// DER of the signed attributes encoded as SET OF (tag 0x31).
    pub fn to_be_signed(&self) -> &[u8] {
        &self.signed_attributes
    }
}

/// Calculates the Authenticode SHA-256 digest of a PE32+ image.
pub fn pe_digest(image: &[u8]) -> Result<[u8; 32], String> {
    let layout = parse_pe(image)?;
    let mut digest = Sha256::new();

    digest.update(
        image
            .get(..layout.checksum_at)
            .ok_or("PE checksum offset exceeds the image")?,
    );
    digest.update(
        image
            .get(layout.checksum_at + 4..layout.certificate_entry_at)
            .ok_or("PE certificate-table entry precedes the checksum")?,
    );
    digest.update(
        image
            .get(layout.certificate_entry_at + 8..layout.size_of_headers)
            .ok_or("PE headers end before the certificate-table entry")?,
    );

    for &(start, end) in &layout.sections {
        digest.update(
            image
                .get(start..end)
                .ok_or("PE section exceeds the image")?,
        );
    }

    let data_after_sections = layout
        .sections
        .last()
        .map_or(layout.size_of_headers, |section| section.1);
    match layout.certificate_table {
        Some((certificate_at, certificate_size)) => {
            digest.update(
                image
                    .get(data_after_sections..certificate_at)
                    .ok_or("PE certificate table overlaps section data")?,
            );
            let after_certificate = certificate_at
                .checked_add(certificate_size)
                .ok_or("PE certificate-table size overflows")?;
            digest.update(
                image
                    .get(after_certificate..)
                    .ok_or("PE certificate table exceeds the image")?,
            );
        }
        None => digest.update(
            image
                .get(data_after_sections..)
                .ok_or("PE section data exceeds the image")?,
        ),
    }

    Ok(digest.finalize().into())
}

/// Prepares a PE32+ image and certificate for an external RSA signer.
pub fn prepare(image: &[u8], certificate_der: &[u8]) -> Result<Prepared, String> {
    let layout = parse_pe(image)?;
    if layout.certificate_table.is_some() {
        return Err("PE image already has a certificate table".to_owned());
    }
    let (issuer_der, serial_der) = certificate_identity(certificate_der)?;

    let mut image = image.to_vec();
    image.resize(align_up(image.len(), 8)?, 0);
    let image_digest = pe_digest(&image)?;
    let spc_indirect_data = make_spc_indirect_data(&image_digest);
    let indirect_contents = der_object(&spc_indirect_data)?.value;
    let message_digest: [u8; 32] = Sha256::digest(indirect_contents).into();
    let signed_attributes = make_signed_attributes(&message_digest);

    Ok(Prepared {
        image,
        certificate_der: certificate_der.to_vec(),
        issuer_der,
        serial_der,
        spc_indirect_data,
        signed_attributes,
    })
}

/// Finishes an Authenticode signature and appends its WIN_CERTIFICATE.
pub fn finish(mut prepared: Prepared, rsa_signature: &[u8]) -> Result<Vec<u8>, String> {
    if rsa_signature.is_empty() {
        return Err("RSA signature is empty".to_owned());
    }

    let cms = make_cms(&prepared, rsa_signature);
    let win_certificate_len = align_up(
        8usize
            .checked_add(cms.len())
            .ok_or("WIN_CERTIFICATE length overflows")?,
        8,
    )?;
    let certificate_at = prepared.image.len();
    let certificate_at_u32 =
        u32::try_from(certificate_at).map_err(|_| "PE certificate-table offset exceeds u32")?;
    let certificate_size_u32 =
        u32::try_from(win_certificate_len).map_err(|_| "PE certificate-table size exceeds u32")?;
    let win_certificate_len_u32 = certificate_size_u32;

    let layout = parse_pe(&prepared.image)?;
    prepared.image[layout.certificate_entry_at..layout.certificate_entry_at + 4]
        .copy_from_slice(&certificate_at_u32.to_le_bytes());
    prepared.image[layout.certificate_entry_at + 4..layout.certificate_entry_at + 8]
        .copy_from_slice(&certificate_size_u32.to_le_bytes());

    prepared
        .image
        .extend_from_slice(&win_certificate_len_u32.to_le_bytes());
    prepared
        .image
        .extend_from_slice(&WIN_CERT_REVISION_2_0.to_le_bytes());
    prepared
        .image
        .extend_from_slice(&WIN_CERT_TYPE_PKCS_SIGNED_DATA.to_le_bytes());
    prepared.image.extend_from_slice(&cms);
    prepared.image.resize(
        certificate_at
            .checked_add(win_certificate_len)
            .ok_or("signed PE length overflows")?,
        0,
    );

    prepared.image[layout.checksum_at..layout.checksum_at + 4].fill(0);
    let checksum = pe_checksum(&prepared.image, layout.checksum_at)?;
    prepared.image[layout.checksum_at..layout.checksum_at + 4]
        .copy_from_slice(&checksum.to_le_bytes());
    Ok(prepared.image)
}

/// Prepares, signs and finishes an Authenticode-signed PE image.
pub fn sign_with(
    image: &[u8],
    certificate_der: &[u8],
    signer: impl FnOnce(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    let prepared = prepare(image, certificate_der)?;
    let signature = signer(prepared.to_be_signed())?;
    finish(prepared, &signature)
}

/// Returns the X.509 certificates embedded in PKCS#7 WIN_CERTIFICATE entries.
pub fn embedded_certificates(image: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let layout = parse_pe(image)?;
    let Some((at, size)) = layout.certificate_table else {
        return Ok(Vec::new());
    };
    let table = image
        .get(at..at + size)
        .ok_or("PE certificate table exceeds the image")?;
    let certificates = parse_win_certificates(table)?;
    let mut output = Vec::new();
    for certificate in certificates {
        if certificate.certificate_type != WIN_CERT_TYPE_PKCS_SIGNED_DATA {
            continue;
        }
        output.extend(extract_cms_certificates(certificate.payload)?);
    }
    Ok(output)
}

/// Checks the Authenticode structure and covered digests without verifying RSA.
pub fn check_signed(image: &[u8], certificate_der: &[u8]) -> Result<(), String> {
    let layout = parse_pe(image)?;
    let (table_at, table_size) = layout
        .certificate_table
        .ok_or("PE image has no certificate table")?;
    if table_at
        .checked_add(table_size)
        .filter(|end| *end == image.len())
        .is_none()
    {
        return Err("PE certificate table is not the final image data".to_owned());
    }
    let table = image
        .get(table_at..)
        .ok_or("PE certificate table exceeds the image")?;
    let win_certificates = parse_win_certificates(table)?;
    if win_certificates.len() != 1 {
        return Err("PE image must contain exactly one WIN_CERTIFICATE".to_owned());
    }
    let win_certificate = &win_certificates[0];
    if win_certificate.revision != WIN_CERT_REVISION_2_0
        || win_certificate.certificate_type != WIN_CERT_TYPE_PKCS_SIGNED_DATA
    {
        return Err("WIN_CERTIFICATE is not a revision 2 PKCS#7 signature".to_owned());
    }

    check_cms(win_certificate.payload, certificate_der, &pe_digest(image)?)
}

fn parse_pe(image: &[u8]) -> Result<PeLayout, String> {
    if image.get(..2) != Some(b"MZ") {
        return Err("PE image has no DOS signature".to_owned());
    }
    let pe_at = usize_from_u32(read_u32(image, 0x3c, "PE header offset is truncated")?)?;
    if image.get(pe_at..pe_at.saturating_add(4)) != Some(b"PE\0\0") {
        return Err("PE image has no PE signature".to_owned());
    }
    let coff_at = pe_at.checked_add(4).ok_or("PE header offset overflows")?;
    let coff = image
        .get(coff_at..coff_at + 20)
        .ok_or("PE COFF header is truncated")?;
    let section_count = usize::from(u16::from_le_bytes(
        coff[2..4]
            .try_into()
            .map_err(|_| "PE section count is truncated")?,
    ));
    let optional_size = usize::from(u16::from_le_bytes(
        coff[16..18]
            .try_into()
            .map_err(|_| "PE optional-header size is truncated")?,
    ));
    let optional_at = coff_at
        .checked_add(20)
        .ok_or("PE optional-header offset overflows")?;
    let optional_end = optional_at
        .checked_add(optional_size)
        .filter(|end| *end <= image.len())
        .ok_or("PE optional header is truncated")?;
    if read_u16(image, optional_at, "PE optional-header magic is truncated")? != 0x20b {
        return Err("expected a PE32+ image".to_owned());
    }
    if optional_size < 152 {
        return Err("PE32+ optional header has no certificate-table entry".to_owned());
    }
    let directory_count = read_u32(
        image,
        optional_at + 108,
        "PE data-directory count is truncated",
    )?;
    if directory_count < 5 {
        return Err("PE optional header has no certificate-table directory".to_owned());
    }

    let checksum_at = optional_at + 64;
    let certificate_entry_at = optional_at + 112 + 4 * 8;
    let size_of_headers = usize_from_u32(read_u32(
        image,
        optional_at + 60,
        "PE SizeOfHeaders is truncated",
    )?)?;
    let section_table_at = optional_end;
    let section_table_end = section_table_at
        .checked_add(
            section_count
                .checked_mul(40)
                .ok_or("PE section-table size overflows")?,
        )
        .filter(|end| *end <= image.len())
        .ok_or("PE section table is truncated")?;
    if size_of_headers < section_table_end || size_of_headers > image.len() {
        return Err("PE SizeOfHeaders does not contain the headers".to_owned());
    }

    let mut sections = Vec::with_capacity(section_count);
    for index in 0..section_count {
        let at = section_table_at + index * 40;
        let size = usize_from_u32(read_u32(
            image,
            at + 16,
            "PE section raw-data size is truncated",
        )?)?;
        if size == 0 {
            continue;
        }
        let start = usize_from_u32(read_u32(
            image,
            at + 20,
            "PE section raw-data offset is truncated",
        )?)?;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= image.len())
            .ok_or("PE section raw data is truncated")?;
        if start < size_of_headers {
            return Err("PE section overlaps the headers".to_owned());
        }
        sections.push((start, end));
    }
    sections.sort_unstable_by_key(|section| section.0);
    for pair in sections.windows(2) {
        if pair[1].0 < pair[0].1 {
            return Err("PE sections overlap".to_owned());
        }
    }

    let certificate_at = usize_from_u32(read_u32(
        image,
        certificate_entry_at,
        "PE certificate-table offset is truncated",
    )?)?;
    let certificate_size = usize_from_u32(read_u32(
        image,
        certificate_entry_at + 4,
        "PE certificate-table size is truncated",
    )?)?;
    let certificate_table = match (certificate_at, certificate_size) {
        (0, 0) => None,
        (0, _) | (_, 0) => {
            return Err("PE certificate-table entry has an offset/size mismatch".to_owned());
        }
        (at, size) => {
            if !at.is_multiple_of(8) {
                return Err("PE certificate table is not 8-byte aligned".to_owned());
            }
            let data_after_sections = sections.last().map_or(size_of_headers, |section| section.1);
            if at < data_after_sections {
                return Err("PE certificate table overlaps section data".to_owned());
            }
            at.checked_add(size)
                .filter(|end| *end <= image.len())
                .ok_or("PE certificate table is truncated")?;
            Some((at, size))
        }
    };

    Ok(PeLayout {
        checksum_at,
        certificate_entry_at,
        size_of_headers,
        sections,
        certificate_table,
    })
}

fn read_u16(bytes: &[u8], at: usize, error: &'static str) -> Result<u16, String> {
    Ok(u16::from_le_bytes(
        bytes
            .get(at..at + 2)
            .ok_or(error)?
            .try_into()
            .map_err(|_| error)?,
    ))
}

fn read_u32(bytes: &[u8], at: usize, error: &'static str) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .ok_or(error)?
            .try_into()
            .map_err(|_| error)?,
    ))
}

fn usize_from_u32(value: u32) -> Result<usize, String> {
    usize::try_from(value).map_err(|_| "PE offset does not fit in memory".to_owned())
}

fn align_up(value: usize, alignment: usize) -> Result<usize, String> {
    value
        .checked_add(alignment - 1)
        .map(|sum| sum & !(alignment - 1))
        .ok_or_else(|| "aligned length overflows".to_owned())
}

fn certificate_identity(certificate_der: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let certificate = Certificate::from_der(certificate_der)
        .map_err(|error| format!("invalid X.509 certificate: {error}"))?;
    if certificate
        .to_der()
        .map_err(|error| format!("cannot encode X.509 certificate: {error}"))?
        != certificate_der
    {
        return Err("X.509 certificate is not canonical DER".to_owned());
    }
    let issuer = certificate
        .tbs_certificate()
        .issuer()
        .to_der()
        .map_err(|error| format!("cannot encode certificate issuer: {error}"))?;
    let serial = certificate
        .tbs_certificate()
        .serial_number()
        .to_der()
        .map_err(|error| format!("cannot encode certificate serial: {error}"))?;
    Ok((issuer, serial))
}

fn make_spc_pe_image_data() -> Vec<u8> {
    let mut obsolete = Vec::new();
    for unit in "<<<Obsolete>>>".encode_utf16() {
        obsolete.extend_from_slice(&unit.to_be_bytes());
    }
    sequence(&[
        der_tlv(0x03, &[0]),
        der_tlv(0xa0, &der_tlv(0xa2, &der_tlv(0x80, &obsolete))),
    ])
}

fn make_spc_indirect_data(image_digest: &[u8; 32]) -> Vec<u8> {
    // SpcAttributeTypeAndOptionalValue carries SpcPeImageData directly (ANY, not [0] EXPLICIT), as
    // signtool and osslsigncode encode it; Windows rejects the wrapped form as a bad digest.
    let data = sequence(&[oid(OID_SPC_PE_IMAGE_DATA), make_spc_pe_image_data()]);
    let digest_info = sequence(&[
        algorithm_identifier(OID_SHA256),
        der_tlv(0x04, image_digest),
    ]);
    sequence(&[data, digest_info])
}

fn make_signed_attributes(message_digest: &[u8; 32]) -> Vec<u8> {
    let mut attributes = [
        attribute(OID_CONTENT_TYPE, oid(OID_SPC_INDIRECT_DATA)),
        attribute(OID_MESSAGE_DIGEST, der_tlv(0x04, message_digest)),
        attribute(OID_SPC_SP_OPUS_INFO, sequence(&[])),
    ];
    attributes.sort();
    der_tlv(0x31, &attributes.concat())
}

fn attribute(attribute_oid: &[u8], value: Vec<u8>) -> Vec<u8> {
    sequence(&[oid(attribute_oid), der_tlv(0x31, &value)])
}

fn make_cms(prepared: &Prepared, rsa_signature: &[u8]) -> Vec<u8> {
    let signed_attributes_implicit = {
        let object = der_object(&prepared.signed_attributes)
            .expect("signed attributes constructed by this module are valid DER");
        der_tlv(0xa0, object.value)
    };
    let signer_info = sequence(&[
        integer_one(),
        sequence(&[prepared.issuer_der.clone(), prepared.serial_der.clone()]),
        algorithm_identifier(OID_SHA256),
        signed_attributes_implicit,
        algorithm_identifier(OID_RSA_ENCRYPTION),
        der_tlv(0x04, rsa_signature),
    ]);
    let signed_data = sequence(&[
        integer_one(),
        der_tlv(0x31, &algorithm_identifier(OID_SHA256)),
        sequence(&[
            oid(OID_SPC_INDIRECT_DATA),
            der_tlv(0xa0, &prepared.spc_indirect_data),
        ]),
        der_tlv(0xa0, &prepared.certificate_der),
        der_tlv(0x31, &signer_info),
    ]);
    sequence(&[oid(OID_SIGNED_DATA), der_tlv(0xa0, &signed_data)])
}

fn algorithm_identifier(algorithm_oid: &[u8]) -> Vec<u8> {
    sequence(&[oid(algorithm_oid), der_tlv(0x05, &[])])
}

fn integer_one() -> Vec<u8> {
    der_tlv(0x02, &[1])
}

fn oid(value: &[u8]) -> Vec<u8> {
    der_tlv(0x06, value)
}

fn sequence(parts: &[Vec<u8>]) -> Vec<u8> {
    der_tlv(0x30, &parts.concat())
}

fn der_tlv(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(1 + 5 + value.len());
    output.push(tag);
    encode_der_length(value.len(), &mut output);
    output.extend_from_slice(value);
    output
}

fn encode_der_length(length: usize, output: &mut Vec<u8>) {
    if length < 128 {
        output.push(length as u8);
        return;
    }
    let bytes = length.to_be_bytes();
    let first = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len() - 1);
    let encoded = &bytes[first..];
    output.push(0x80 | encoded.len() as u8);
    output.extend_from_slice(encoded);
}

#[derive(Clone, Copy, Debug)]
struct DerObject<'a> {
    tag: u8,
    full: &'a [u8],
    value: &'a [u8],
}

fn der_object(bytes: &[u8]) -> Result<DerObject<'_>, String> {
    let (object, remainder) = der_object_partial(bytes)?;
    if !remainder.is_empty() {
        return Err("DER value has trailing data".to_owned());
    }
    Ok(object)
}

fn der_object_partial(bytes: &[u8]) -> Result<(DerObject<'_>, &[u8]), String> {
    let tag = *bytes.first().ok_or("DER value is truncated")?;
    if tag & 0x1f == 0x1f {
        return Err("high-tag-number DER is unsupported".to_owned());
    }
    let first_length = *bytes.get(1).ok_or("DER length is truncated")?;
    let (length, header_len) = if first_length < 0x80 {
        (usize::from(first_length), 2usize)
    } else {
        let count = usize::from(first_length & 0x7f);
        if count == 0 || count > std::mem::size_of::<usize>() {
            return Err("DER length is invalid".to_owned());
        }
        let encoded = bytes.get(2..2 + count).ok_or("DER length is truncated")?;
        if encoded.first() == Some(&0) {
            return Err("DER length is not minimally encoded".to_owned());
        }
        let mut length = 0usize;
        for byte in encoded {
            length = length
                .checked_mul(256)
                .and_then(|value| value.checked_add(usize::from(*byte)))
                .ok_or("DER length overflows")?;
        }
        if length < 128 {
            return Err("DER length is not minimally encoded".to_owned());
        }
        (length, 2 + count)
    };
    let full_len = header_len
        .checked_add(length)
        .filter(|end| *end <= bytes.len())
        .ok_or("DER value is truncated")?;
    let full = &bytes[..full_len];
    Ok((
        DerObject {
            tag,
            full,
            value: &full[header_len..],
        },
        &bytes[full_len..],
    ))
}

fn der_children<'a>(
    object: DerObject<'a>,
    tag: u8,
    name: &str,
) -> Result<Vec<DerObject<'a>>, String> {
    if object.tag != tag {
        return Err(format!("{name} has the wrong DER tag"));
    }
    let mut children = Vec::new();
    let mut remaining = object.value;
    while !remaining.is_empty() {
        let (child, rest) = der_object_partial(remaining)?;
        children.push(child);
        remaining = rest;
    }
    Ok(children)
}

fn expect_exact(object: DerObject<'_>, expected: &[u8], name: &str) -> Result<(), String> {
    if object.full != expected {
        return Err(format!("{name} has an unexpected DER value"));
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct WinCertificate<'a> {
    revision: u16,
    certificate_type: u16,
    payload: &'a [u8],
}

fn parse_win_certificates(table: &[u8]) -> Result<Vec<WinCertificate<'_>>, String> {
    let mut certificates = Vec::new();
    let mut remaining = table;
    while !remaining.is_empty() {
        let header = remaining
            .get(..8)
            .ok_or("WIN_CERTIFICATE header is truncated")?;
        let length = usize_from_u32(u32::from_le_bytes(
            header[..4]
                .try_into()
                .map_err(|_| "WIN_CERTIFICATE length is truncated")?,
        ))?;
        if length < 8 || !length.is_multiple_of(8) {
            return Err("WIN_CERTIFICATE length is not 8-byte aligned".to_owned());
        }
        let entry = remaining
            .get(..length)
            .ok_or("WIN_CERTIFICATE exceeds the certificate table")?;
        let revision = u16::from_le_bytes(
            header[4..6]
                .try_into()
                .map_err(|_| "WIN_CERTIFICATE revision is truncated")?,
        );
        let certificate_type = u16::from_le_bytes(
            header[6..8]
                .try_into()
                .map_err(|_| "WIN_CERTIFICATE type is truncated")?,
        );
        let encoded = &entry[8..];
        let (cms, padding) = der_object_partial(encoded)?;
        if padding.iter().any(|byte| *byte != 0) {
            return Err("WIN_CERTIFICATE padding is not zero".to_owned());
        }
        certificates.push(WinCertificate {
            revision,
            certificate_type,
            payload: cms.full,
        });
        remaining = &remaining[length..];
    }
    Ok(certificates)
}

fn cms_signed_data(cms: &[u8]) -> Result<Vec<DerObject<'_>>, String> {
    let content_info = der_children(der_object(cms)?, 0x30, "CMS ContentInfo")?;
    if content_info.len() != 2 {
        return Err("CMS ContentInfo has unexpected fields".to_owned());
    }
    expect_exact(content_info[0], &oid(OID_SIGNED_DATA), "CMS content type")?;
    let explicit = der_children(content_info[1], 0xa0, "CMS signedData wrapper")?;
    if explicit.len() != 1 {
        return Err("CMS signedData wrapper has unexpected fields".to_owned());
    }
    der_children(explicit[0], 0x30, "CMS SignedData")
}

fn extract_cms_certificates(cms: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let signed_data = cms_signed_data(cms)?;
    if signed_data.len() != 5 || signed_data[3].tag != 0xa0 {
        return Err("CMS SignedData has unexpected fields".to_owned());
    }
    let mut encoded = signed_data[3].value;
    let mut certificates = Vec::new();
    while !encoded.is_empty() {
        let (certificate, remaining) = der_object_partial(encoded)?;
        if certificate.tag != 0x30 {
            return Err("CMS certificate set contains a non-X.509 choice".to_owned());
        }
        Certificate::from_der(certificate.full)
            .map_err(|error| format!("invalid embedded X.509 certificate: {error}"))?;
        certificates.push(certificate.full.to_vec());
        encoded = remaining;
    }
    Ok(certificates)
}

fn check_cms(cms: &[u8], certificate_der: &[u8], image_digest: &[u8; 32]) -> Result<(), String> {
    let signed_data = cms_signed_data(cms)?;
    if signed_data.len() != 5 {
        return Err("CMS SignedData has unexpected fields".to_owned());
    }
    expect_exact(signed_data[0], &integer_one(), "CMS SignedData version")?;
    expect_exact(
        signed_data[1],
        &der_tlv(0x31, &algorithm_identifier(OID_SHA256)),
        "CMS digest algorithms",
    )?;

    let encapsulated = der_children(signed_data[2], 0x30, "CMS encapsulated content")?;
    if encapsulated.len() != 2 {
        return Err("CMS encapsulated content has unexpected fields".to_owned());
    }
    expect_exact(
        encapsulated[0],
        &oid(OID_SPC_INDIRECT_DATA),
        "CMS encapsulated content type",
    )?;
    let indirect_wrapper = der_children(encapsulated[1], 0xa0, "CMS eContent wrapper")?;
    if indirect_wrapper.len() != 1 || indirect_wrapper[0].tag != 0x30 {
        return Err("CMS eContent is not SpcIndirectDataContent".to_owned());
    }
    let expected_indirect = make_spc_indirect_data(image_digest);
    expect_exact(
        indirect_wrapper[0],
        &expected_indirect,
        "SpcIndirectDataContent",
    )?;

    if signed_data[3].tag != 0xa0 {
        return Err("CMS certificates field is missing".to_owned());
    }
    let embedded = extract_cms_certificates(cms)?;
    if embedded.len() != 1 || embedded[0] != certificate_der {
        return Err("CMS signer certificate does not match the expected certificate".to_owned());
    }
    let (issuer_der, serial_der) = certificate_identity(certificate_der)?;

    let signer_infos = der_children(signed_data[4], 0x31, "CMS signerInfos")?;
    if signer_infos.len() != 1 {
        return Err("CMS must contain exactly one SignerInfo".to_owned());
    }
    let signer_info = der_children(signer_infos[0], 0x30, "CMS SignerInfo")?;
    if signer_info.len() != 6 {
        return Err("CMS SignerInfo has unexpected fields".to_owned());
    }
    expect_exact(signer_info[0], &integer_one(), "CMS SignerInfo version")?;
    expect_exact(
        signer_info[1],
        &sequence(&[issuer_der, serial_der]),
        "CMS signer identifier",
    )?;
    expect_exact(
        signer_info[2],
        &algorithm_identifier(OID_SHA256),
        "CMS signer digest algorithm",
    )?;
    if signer_info[3].tag != 0xa0 {
        return Err("CMS signed attributes are missing".to_owned());
    }
    let message_digest: [u8; 32] = Sha256::digest(indirect_wrapper[0].value).into();
    let expected_attributes = make_signed_attributes(&message_digest);
    let expected_attribute_contents = der_object(&expected_attributes)?.value;
    if signer_info[3].value != expected_attribute_contents {
        return Err("CMS signed attributes do not match the content".to_owned());
    }
    expect_exact(
        signer_info[4],
        &algorithm_identifier(OID_RSA_ENCRYPTION),
        "CMS signature algorithm",
    )?;
    if signer_info[5].tag != 0x04 || signer_info[5].value.is_empty() {
        return Err("CMS RSA signature is missing".to_owned());
    }
    Ok(())
}

fn pe_checksum(image: &[u8], checksum_at: usize) -> Result<u32, String> {
    image
        .get(checksum_at..checksum_at + 4)
        .ok_or("PE checksum field is truncated")?;
    let mut sum = 0u64;
    let mut at = 0usize;
    while at < image.len() {
        let word = if at == checksum_at || at == checksum_at + 2 {
            0u16
        } else {
            let low = u16::from(image[at]);
            let high = image.get(at + 1).map_or(0, |byte| u16::from(*byte));
            low | (high << 8)
        };
        sum += u64::from(word);
        sum = (sum & 0xffff) + (sum >> 16);
        at += 2;
    }
    sum = (sum & 0xffff) + (sum >> 16);
    sum = (sum & 0xffff) + (sum >> 16);
    let length = u32::try_from(image.len()).map_err(|_| "PE image length exceeds u32")?;
    Ok((sum as u32).wrapping_add(length))
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::{OsStr, OsString},
        fs,
        io::Write,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    const PROJECT_CERTIFICATE: &[u8] = include_bytes!("../../../secure-boot/NvStrapsReBar-db.cer");

    /// The layout Windows accepts, as signtool writes it: SpcPeImageData sits directly after its OID.
    #[test]
    fn spc_indirect_data_matches_the_signtool_layout() {
        let digest = [0x5a; 32];
        let mut expected = vec![0x30, 0x33, 0x06, 0x0a];
        expected.extend_from_slice(OID_SPC_PE_IMAGE_DATA);
        expected.extend_from_slice(&[
            0x30, 0x25, 0x03, 0x01, 0x00, 0xa0, 0x20, 0xa2, 0x1e, 0x80, 0x1c,
        ]);
        for unit in "<<<Obsolete>>>".encode_utf16() {
            expected.extend_from_slice(&unit.to_be_bytes());
        }
        expected.extend_from_slice(&[
            0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
            0x01, 0x05, 0x00, 0x04, 0x20,
        ]);
        expected.extend_from_slice(&digest);
        let mut whole = vec![0x30, expected.len() as u8];
        whole.extend_from_slice(&expected);
        assert_eq!(make_spc_indirect_data(&digest), whole);
    }

    struct Cleanup(PathBuf);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn minimal_pe32_plus() -> Vec<u8> {
        let mut image = vec![0u8; 0x530];
        image[..2].copy_from_slice(b"MZ");
        image[0x3c..0x40].copy_from_slice(&0x80_u32.to_le_bytes());
        image[0x80..0x84].copy_from_slice(b"PE\0\0");
        image[0x84..0x86].copy_from_slice(&0x8664_u16.to_le_bytes());
        image[0x86..0x88].copy_from_slice(&2_u16.to_le_bytes());
        image[0x94..0x96].copy_from_slice(&0xf0_u16.to_le_bytes());
        image[0x98..0x9a].copy_from_slice(&0x20b_u16.to_le_bytes());
        image[0xd4..0xd8].copy_from_slice(&0x200_u32.to_le_bytes());
        image[0xdc..0xde].copy_from_slice(&10_u16.to_le_bytes());
        image[0x104..0x108].copy_from_slice(&16_u32.to_le_bytes());

        let first = 0x188;
        image[first..first + 5].copy_from_slice(b".data");
        image[first + 16..first + 20].copy_from_slice(&0x100_u32.to_le_bytes());
        image[first + 20..first + 24].copy_from_slice(&0x400_u32.to_le_bytes());
        let second = first + 40;
        image[second..second + 5].copy_from_slice(b".text");
        image[second + 16..second + 20].copy_from_slice(&0x180_u32.to_le_bytes());
        image[second + 20..second + 24].copy_from_slice(&0x200_u32.to_le_bytes());

        for (index, byte) in image[0x200..0x380].iter_mut().enumerate() {
            *byte = (index as u8).wrapping_mul(17).wrapping_add(3);
        }
        image[0x380..0x400].fill(0xee);
        for (index, byte) in image[0x400..0x500].iter_mut().enumerate() {
            *byte = (index as u8).wrapping_mul(29).wrapping_add(7);
        }
        for (index, byte) in image[0x500..].iter_mut().enumerate() {
            *byte = (index as u8).wrapping_mul(11).wrapping_add(5);
        }
        image
    }

    fn fixture_image() -> Vec<u8> {
        let built = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/x86_64-unknown-uefi/release/NvStrapsDiagnostic.efi");
        if built.is_file() {
            fs::read(built).unwrap()
        } else {
            minimal_pe32_plus()
        }
    }

    fn independent_digest(image: &[u8]) -> [u8; 32] {
        let pe = u32::from_le_bytes(image[0x3c..0x40].try_into().unwrap()) as usize;
        let optional = pe + 24;
        let optional_size =
            u16::from_le_bytes(image[pe + 20..pe + 22].try_into().unwrap()) as usize;
        let section_count = u16::from_le_bytes(image[pe + 6..pe + 8].try_into().unwrap()) as usize;
        let headers =
            u32::from_le_bytes(image[optional + 60..optional + 64].try_into().unwrap()) as usize;
        let checksum = optional + 64;
        let security = optional + 144;
        let mut hasher = Sha256::new();
        for range in [0..checksum, checksum + 4..security, security + 8..headers] {
            hasher.update(&image[range]);
        }
        let section_table = optional + optional_size;
        let mut ranges = (0..section_count)
            .filter_map(|index| {
                let at = section_table + index * 40;
                let size = u32::from_le_bytes(image[at + 16..at + 20].try_into().unwrap()) as usize;
                let start =
                    u32::from_le_bytes(image[at + 20..at + 24].try_into().unwrap()) as usize;
                (size != 0).then_some(start..start + size)
            })
            .collect::<Vec<_>>();
        ranges.sort_by_key(|range| range.start);
        for range in &ranges {
            hasher.update(&image[range.clone()]);
        }
        let after_sections = ranges.last().map_or(headers, |range| range.end);
        let certificate_at =
            u32::from_le_bytes(image[security..security + 4].try_into().unwrap()) as usize;
        let certificate_size =
            u32::from_le_bytes(image[security + 4..security + 8].try_into().unwrap()) as usize;
        if certificate_at == 0 {
            hasher.update(&image[after_sections..]);
        } else {
            hasher.update(&image[after_sections..certificate_at]);
            hasher.update(&image[certificate_at + certificate_size..]);
        }
        hasher.finalize().into()
    }

    fn hex(bytes: &[u8]) -> String {
        use std::fmt::Write as _;
        let mut output = String::new();
        for byte in bytes {
            write!(output, "{byte:02x}").unwrap();
        }
        output
    }

    #[test]
    fn pe_digest_matches_an_independent_computation_and_known_fixture_value() {
        let minimal = minimal_pe32_plus();
        assert_eq!(pe_digest(&minimal).unwrap(), independent_digest(&minimal));
        assert_eq!(
            hex(&pe_digest(&minimal).unwrap()),
            "2380ee06d09fd3a06c6e55366632a2abf0bca887103c617c37cd734fc9372cec"
        );

        let fixture = fixture_image();
        assert_eq!(pe_digest(&fixture).unwrap(), independent_digest(&fixture));
    }

    #[test]
    fn fake_signer_output_is_structural_deterministic_and_detects_changes() {
        let image = fixture_image();
        let first = sign_with(&image, PROJECT_CERTIFICATE, |_| Ok(vec![0xa5; 256])).unwrap();
        let second = sign_with(&image, PROJECT_CERTIFICATE, |_| Ok(vec![0xa5; 256])).unwrap();
        assert_eq!(first, second);
        check_signed(&first, PROJECT_CERTIFICATE).unwrap();
        assert_eq!(
            embedded_certificates(&first).unwrap(),
            vec![PROJECT_CERTIFICATE.to_vec()]
        );
        assert!(embedded_certificates(&image).unwrap().is_empty());

        let mut flipped = first.clone();
        let section_byte = parse_pe(&flipped).unwrap().sections[0].0;
        flipped[section_byte] ^= 1;
        assert!(check_signed(&flipped, PROJECT_CERTIFICATE).is_err());

        let mut wrong_certificate = PROJECT_CERTIFICATE.to_vec();
        *wrong_certificate.last_mut().unwrap() ^= 1;
        Certificate::from_der(&wrong_certificate).unwrap();
        assert!(check_signed(&first, &wrong_certificate).is_err());
        assert!(prepare(&first, PROJECT_CERTIFICATE).is_err());
    }

    #[test]
    fn refuses_pe32_truncated_and_overlapping_images() {
        let image = minimal_pe32_plus();
        let mut pe32 = image.clone();
        pe32[0x98..0x9a].copy_from_slice(&0x10b_u16.to_le_bytes());
        assert!(prepare(&pe32, PROJECT_CERTIFICATE).is_err());

        for length in [0, 2, 0x40, 0x90, 0x180, 0x450] {
            assert!(prepare(&image[..length], PROJECT_CERTIFICATE).is_err());
        }

        let mut overlap = image;
        let second_section = 0x188 + 40;
        overlap[second_section + 20..second_section + 24].copy_from_slice(&0x480_u32.to_le_bytes());
        assert!(prepare(&overlap, PROJECT_CERTIFICATE).is_err());
    }

    #[test]
    fn finish_aligns_the_certificate_table_and_sets_the_checksum() {
        let image = minimal_pe32_plus();
        let unsigned_len = align_up(image.len(), 8).unwrap();
        let signed = sign_with(&image, PROJECT_CERTIFICATE, |_| Ok(vec![0x33; 257])).unwrap();
        let layout = parse_pe(&signed).unwrap();
        let (certificate_at, certificate_size) = layout.certificate_table.unwrap();
        assert_eq!(certificate_at, unsigned_len);
        assert_eq!(certificate_at % 8, 0);
        assert_eq!(certificate_size % 8, 0);
        assert_eq!(certificate_at + certificate_size, signed.len());
        assert_eq!(
            u32::from_le_bytes(
                signed[certificate_at..certificate_at + 4]
                    .try_into()
                    .unwrap()
            ) as usize,
            certificate_size
        );
        let stored_checksum = u32::from_le_bytes(
            signed[layout.checksum_at..layout.checksum_at + 4]
                .try_into()
                .unwrap(),
        );
        assert_ne!(stored_checksum, 0);
        assert_eq!(
            stored_checksum,
            pe_checksum(&signed, layout.checksum_at).unwrap()
        );
        check_signed(&signed, PROJECT_CERTIFICATE).unwrap();
    }

    fn openssl() -> Option<OsString> {
        let executable =
            std::env::var_os("NVSTRAPS_OPENSSL").unwrap_or_else(|| OsString::from("openssl"));
        Command::new(&executable)
            .arg("version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()
            .filter(|status| status.success())
            .map(|_| executable)
    }

    fn command_succeeds(executable: &OsStr, arguments: &[&OsStr]) {
        let output = Command::new(executable).args(arguments).output().unwrap();
        assert!(
            output.status.success(),
            "openssl failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn openssl_sign(executable: &OsStr, key: &Path, bytes: &[u8]) -> Vec<u8> {
        let mut child = Command::new(executable)
            .args([
                OsStr::new("dgst"),
                OsStr::new("-sha256"),
                OsStr::new("-sign"),
            ])
            .arg(key)
            .arg("-binary")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "openssl signing failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    #[test]
    fn real_rsa_signature_round_trip_with_openssl() {
        let Some(openssl) = openssl() else {
            eprintln!("skipping real RSA test: openssl was not found");
            return;
        };
        let directory = std::env::temp_dir().join(format!(
            "nvstraps-authenticode-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let _cleanup = Cleanup(directory.clone());
        let key = directory.join("key.pem");
        let certificate = directory.join("certificate.der");
        let public_key = directory.join("public.pem");
        command_succeeds(
            &openssl,
            &[
                OsStr::new("req"),
                OsStr::new("-x509"),
                OsStr::new("-newkey"),
                OsStr::new("rsa:2048"),
                OsStr::new("-keyout"),
                key.as_os_str(),
                OsStr::new("-out"),
                certificate.as_os_str(),
                OsStr::new("-outform"),
                OsStr::new("DER"),
                OsStr::new("-nodes"),
                OsStr::new("-subj"),
                OsStr::new("/CN=NvStraps Authenticode test"),
                OsStr::new("-days"),
                OsStr::new("1"),
                OsStr::new("-sha256"),
            ],
        );
        command_succeeds(
            &openssl,
            &[
                OsStr::new("x509"),
                OsStr::new("-inform"),
                OsStr::new("DER"),
                OsStr::new("-in"),
                certificate.as_os_str(),
                OsStr::new("-pubkey"),
                OsStr::new("-noout"),
                OsStr::new("-out"),
                public_key.as_os_str(),
            ],
        );

        let certificate_der = fs::read(&certificate).unwrap();
        let prepared = prepare(&fixture_image(), &certificate_der).unwrap();
        let to_be_signed = prepared.to_be_signed().to_vec();
        let signature = openssl_sign(&openssl, &key, &to_be_signed);
        let signed = finish(prepared, &signature).unwrap();
        check_signed(&signed, &certificate_der).unwrap();
        assert!(check_signed(&signed, PROJECT_CERTIFICATE).is_err());

        let signed_attributes = directory.join("signed-attributes.der");
        let signature_path = directory.join("signature.bin");
        fs::write(&signed_attributes, &to_be_signed).unwrap();
        fs::write(&signature_path, &signature).unwrap();
        command_succeeds(
            &openssl,
            &[
                OsStr::new("dgst"),
                OsStr::new("-sha256"),
                OsStr::new("-verify"),
                public_key.as_os_str(),
                OsStr::new("-signature"),
                signature_path.as_os_str(),
                signed_attributes.as_os_str(),
            ],
        );
    }
}
