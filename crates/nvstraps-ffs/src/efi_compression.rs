// SPDX-License-Identifier: BSD-2-Clause-Patent
//
// The wire format and length-limited Huffman construction are derived from
// TianoCore EDK2 BaseTools EfiCompress.c, TianoCompress.c, and Decompress.c.

use std::{cmp::Reverse, collections::BinaryHeap, fmt};

const HEADER_SIZE: usize = 8;
const MAX_DECOMPRESSED_SIZE: usize = 64 * 1024 * 1024;
const MAX_MATCH: usize = 256;
const MIN_MATCH: usize = 3;
const NC: usize = 0xff + MAX_MATCH + 2 - MIN_MATCH;
const NT: usize = 19;
const CBIT: u8 = 9;
const TBIT: u8 = 5;
const MAX_CODE_LENGTH: usize = 16;
const HASH_SIZE: usize = 1 << 16;
const MAX_CHAIN: usize = 1024;
const MAX_BLOCK_TOKENS: usize = u16::MAX as usize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EfiCompression {
    EfiStandard,
    Tiano,
}

impl EfiCompression {
    fn window_bits(self) -> usize {
        match self {
            Self::EfiStandard => 13,
            Self::Tiano => 19,
        }
    }

    fn position_bits(self) -> u8 {
        match self {
            Self::EfiStandard => 4,
            Self::Tiano => 5,
        }
    }

    fn position_symbols(self) -> usize {
        self.window_bits() + 1
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EfiCompressionError {
    InputTooShort,
    InputTooLarge,
    InvalidData(&'static str),
    SizeOverflow,
}

impl fmt::Display for EfiCompressionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooShort => formatter.write_str("EFI compressed input is too short"),
            Self::InputTooLarge => formatter.write_str("EFI compression input exceeds 64 MiB"),
            Self::InvalidData(reason) => write!(formatter, "invalid EFI compressed data: {reason}"),
            Self::SizeOverflow => formatter.write_str("EFI compressed size exceeds 32 bits"),
        }
    }
}

impl std::error::Error for EfiCompressionError {}

pub fn efi_compress(input: &[u8], kind: EfiCompression) -> Result<Vec<u8>, EfiCompressionError> {
    if input.len() > MAX_DECOMPRESSED_SIZE {
        return Err(EfiCompressionError::InputTooLarge);
    }
    if input.is_empty() {
        return Ok(vec![0; HEADER_SIZE]);
    }

    let tokens = tokenize(input, 1 << kind.window_bits());
    let mut writer = BitWriter::default();
    for block in tokens.chunks(MAX_BLOCK_TOKENS) {
        encode_block(block, kind, &mut writer)?;
    }
    let mut payload = writer.finish();
    // EDK2 accounts for one final zero byte after flushing the bit buffer.
    // Keeping it makes our artifacts byte-compatible with the reference tools.
    payload.push(0);
    let compressed_size =
        u32::try_from(payload.len()).map_err(|_| EfiCompressionError::SizeOverflow)?;
    let original_size =
        u32::try_from(input.len()).map_err(|_| EfiCompressionError::SizeOverflow)?;
    let mut output = Vec::with_capacity(HEADER_SIZE + payload.len());
    output.extend_from_slice(&compressed_size.to_le_bytes());
    output.extend_from_slice(&original_size.to_le_bytes());
    output.extend_from_slice(&payload);

    if efi_decompress(&output, kind)? != input {
        return Err(EfiCompressionError::InvalidData(
            "encoder output failed its round trip",
        ));
    }
    Ok(output)
}

pub fn efi_decompress(input: &[u8], kind: EfiCompression) -> Result<Vec<u8>, EfiCompressionError> {
    if input.len() < HEADER_SIZE {
        return Err(EfiCompressionError::InputTooShort);
    }
    let compressed_size = u32::from_le_bytes(
        input[..4]
            .try_into()
            .expect("four-byte header slice was checked"),
    ) as usize;
    let original_size = u32::from_le_bytes(
        input[4..8]
            .try_into()
            .expect("four-byte header slice was checked"),
    ) as usize;
    if original_size > MAX_DECOMPRESSED_SIZE {
        return Err(EfiCompressionError::InputTooLarge);
    }
    if compressed_size
        .checked_add(HEADER_SIZE)
        .ok_or(EfiCompressionError::SizeOverflow)?
        != input.len()
    {
        return Err(EfiCompressionError::InvalidData(
            "compressed size does not match the input",
        ));
    }
    if original_size == 0 {
        return Ok(Vec::new());
    }

    let mut reader = BitReader::new(&input[HEADER_SIZE..]);
    let mut output = Vec::with_capacity(original_size);
    let mut remaining_in_block = 0_usize;
    let mut chars = Huffman::single(0, NC)?;
    let mut positions = Huffman::single(0, kind.position_symbols())?;

    while output.len() < original_size {
        if remaining_in_block == 0 {
            remaining_in_block = reader.read_bits(16)? as usize;
            if remaining_in_block == 0 {
                return Err(EfiCompressionError::InvalidData(
                    "zero-length Huffman block",
                ));
            }
            let extra = read_pt_lengths(&mut reader, NT, TBIT, Some(3))?;
            chars = read_char_lengths(&mut reader, &extra)?;
            positions = read_pt_lengths(
                &mut reader,
                kind.position_symbols(),
                kind.position_bits(),
                None,
            )?;
        }

        let symbol = chars.decode(&mut reader)? as usize;
        remaining_in_block -= 1;
        if symbol < 256 {
            output.push(symbol as u8);
            continue;
        }
        if symbol >= NC {
            return Err(EfiCompressionError::InvalidData(
                "character symbol is out of range",
            ));
        }
        let length = symbol - 253;
        if !(MIN_MATCH..=MAX_MATCH).contains(&length) {
            return Err(EfiCompressionError::InvalidData(
                "match length is out of range",
            ));
        }
        let position_symbol = positions.decode(&mut reader)? as usize;
        let position = if position_symbol > 1 {
            (1_usize << (position_symbol - 1))
                | reader.read_bits((position_symbol - 1) as u8)? as usize
        } else {
            position_symbol
        };
        let distance = position + 1;
        if distance > output.len() || distance > (1 << kind.window_bits()) {
            return Err(EfiCompressionError::InvalidData(
                "match position is out of range",
            ));
        }
        if output.len() + length > original_size {
            return Err(EfiCompressionError::InvalidData(
                "match exceeds the declared output size",
            ));
        }
        for _ in 0..length {
            let byte = output[output.len() - distance];
            output.push(byte);
        }
    }
    if remaining_in_block != 0 {
        return Err(EfiCompressionError::InvalidData(
            "declared output ends before the Huffman block",
        ));
    }
    Ok(output)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Token {
    Literal(u8),
    Match { length: u16, position: u32 },
}

fn tokenize(input: &[u8], window_size: usize) -> Vec<Token> {
    let mut heads = vec![usize::MAX; HASH_SIZE];
    let mut previous = vec![usize::MAX; input.len()];
    let mut output = Vec::new();
    let mut position = 0;

    while position < input.len() {
        let (length, candidate) = find_match(input, position, window_size, &heads, &previous);
        insert_position(input, position, &mut heads, &mut previous);

        if length >= MIN_MATCH {
            let (next_length, _) = find_match(input, position + 1, window_size, &heads, &previous);
            if next_length > length + 1 {
                output.push(Token::Literal(input[position]));
                position += 1;
                continue;
            }
            let distance = position - candidate;
            output.push(Token::Match {
                length: length as u16,
                position: (distance - 1) as u32,
            });
            for consumed in position + 1..position + length {
                insert_position(input, consumed, &mut heads, &mut previous);
            }
            position += length;
        } else {
            output.push(Token::Literal(input[position]));
            position += 1;
        }
    }
    output
}

fn find_match(
    input: &[u8],
    position: usize,
    window_size: usize,
    heads: &[usize],
    previous: &[usize],
) -> (usize, usize) {
    if position + MIN_MATCH > input.len() {
        return (0, 0);
    }
    let maximum = MAX_MATCH.min(input.len() - position);
    let mut candidate = heads[hash_at(input, position)];
    let mut best_length = 0;
    let mut best_candidate = 0;
    let mut inspected = 0;

    while candidate != usize::MAX && inspected < MAX_CHAIN {
        let distance = position - candidate;
        if distance > window_size {
            break;
        }
        let mut length = 0;
        while length < maximum && input[candidate + length] == input[position + length] {
            length += 1;
        }
        if length > best_length && length >= MIN_MATCH {
            best_length = length;
            best_candidate = candidate;
            if length == maximum {
                break;
            }
        }
        candidate = previous[candidate];
        inspected += 1;
    }
    (best_length, best_candidate)
}

fn insert_position(input: &[u8], position: usize, heads: &mut [usize], previous: &mut [usize]) {
    if position + MIN_MATCH > input.len() {
        return;
    }
    let hash = hash_at(input, position);
    previous[position] = heads[hash];
    heads[hash] = position;
}

fn hash_at(input: &[u8], position: usize) -> usize {
    let value = (input[position] as usize * 251 + input[position + 1] as usize) * 251
        + input[position + 2] as usize;
    value & (HASH_SIZE - 1)
}

fn encode_block(
    tokens: &[Token],
    kind: EfiCompression,
    writer: &mut BitWriter,
) -> Result<(), EfiCompressionError> {
    let mut char_frequencies = vec![0_u32; NC];
    let mut position_frequencies = vec![0_u32; kind.position_symbols()];
    for token in tokens {
        match *token {
            Token::Literal(byte) => char_frequencies[byte as usize] += 1,
            Token::Match { length, position } => {
                char_frequencies[length as usize + 253] += 1;
                position_frequencies[position_code(position as usize)] += 1;
            }
        }
    }

    let chars = build_huffman(&char_frequencies)?;
    writer.put(16, tokens.len() as u32);
    if let Some(symbol) = chars.single {
        writer.put(TBIT, 0);
        writer.put(TBIT, 0);
        writer.put(CBIT, 0);
        writer.put(CBIT, symbol as u32);
    } else {
        let extra_frequencies = count_extra_frequencies(&chars.lengths);
        let extra = build_huffman(&extra_frequencies)?;
        if let Some(symbol) = extra.single {
            writer.put(TBIT, 0);
            writer.put(TBIT, symbol as u32);
        } else {
            write_pt_lengths(writer, &extra.lengths, TBIT, Some(3));
        }
        write_char_lengths(writer, &chars.lengths, &extra);
    }

    let positions = build_huffman(&position_frequencies)?;
    if let Some(symbol) = positions.single {
        writer.put(kind.position_bits(), 0);
        writer.put(kind.position_bits(), symbol as u32);
    } else {
        write_pt_lengths(writer, &positions.lengths, kind.position_bits(), None);
    }

    for token in tokens {
        match *token {
            Token::Literal(byte) => chars.write_symbol(writer, byte as usize)?,
            Token::Match { length, position } => {
                chars.write_symbol(writer, length as usize + 253)?;
                let position = position as usize;
                let code = position_code(position);
                positions.write_symbol(writer, code)?;
                if code > 1 {
                    writer.put(
                        (code - 1) as u8,
                        (position & ((1 << (code - 1)) - 1)) as u32,
                    );
                }
            }
        }
    }
    Ok(())
}

fn position_code(position: usize) -> usize {
    (usize::BITS - position.leading_zeros()) as usize
}

fn count_extra_frequencies(lengths: &[u8]) -> Vec<u32> {
    let mut frequencies = vec![0_u32; NT];
    let mut end = lengths.len();
    while end > 0 && lengths[end - 1] == 0 {
        end -= 1;
    }
    let mut index = 0;
    while index < end {
        let length = lengths[index];
        index += 1;
        if length != 0 {
            frequencies[length as usize + 2] += 1;
            continue;
        }
        let start = index - 1;
        while index < end && lengths[index] == 0 {
            index += 1;
        }
        match index - start {
            1..=2 => frequencies[0] += (index - start) as u32,
            3..=18 => frequencies[1] += 1,
            19 => {
                frequencies[0] += 1;
                frequencies[1] += 1;
            }
            _ => frequencies[2] += 1,
        }
    }
    frequencies
}

fn write_pt_lengths(
    writer: &mut BitWriter,
    lengths: &[u8],
    count_bits: u8,
    special: Option<usize>,
) {
    let mut end = lengths.len();
    while end > 0 && lengths[end - 1] == 0 {
        end -= 1;
    }
    writer.put(count_bits, end as u32);
    let mut index = 0;
    while index < end {
        let length = lengths[index] as usize;
        index += 1;
        if length <= 6 {
            writer.put(3, length as u32);
        } else {
            writer.put((length - 3) as u8, (1_u32 << (length - 3)) - 2);
        }
        if special == Some(index) {
            while index < 6 && lengths[index] == 0 {
                index += 1;
            }
            writer.put(2, ((index - 3) & 3) as u32);
        }
    }
}

fn write_char_lengths(writer: &mut BitWriter, lengths: &[u8], extra: &HuffmanEncoding) {
    let mut end = lengths.len();
    while end > 0 && lengths[end - 1] == 0 {
        end -= 1;
    }
    writer.put(CBIT, end as u32);
    let mut index = 0;
    while index < end {
        let length = lengths[index];
        index += 1;
        if length != 0 {
            extra
                .write_symbol(writer, length as usize + 2)
                .expect("generated code lengths are encodable");
            continue;
        }
        let start = index - 1;
        while index < end && lengths[index] == 0 {
            index += 1;
        }
        let count = index - start;
        match count {
            1..=2 => {
                for _ in 0..count {
                    extra
                        .write_symbol(writer, 0)
                        .expect("generated zero run is encodable");
                }
            }
            3..=18 => {
                extra
                    .write_symbol(writer, 1)
                    .expect("generated short zero run is encodable");
                writer.put(4, (count - 3) as u32);
            }
            19 => {
                extra
                    .write_symbol(writer, 0)
                    .expect("generated zero run is encodable");
                extra
                    .write_symbol(writer, 1)
                    .expect("generated short zero run is encodable");
                writer.put(4, 15);
            }
            _ => {
                extra
                    .write_symbol(writer, 2)
                    .expect("generated long zero run is encodable");
                writer.put(CBIT, (count - 20) as u32);
            }
        }
    }
}

fn read_pt_lengths(
    reader: &mut BitReader<'_>,
    symbol_count: usize,
    count_bits: u8,
    special: Option<usize>,
) -> Result<Huffman, EfiCompressionError> {
    let number = reader.read_bits(count_bits)? as usize;
    if number == 0 {
        let symbol = reader.read_bits(count_bits)? as usize;
        return Huffman::single(symbol, symbol_count);
    }
    if number > symbol_count {
        return Err(EfiCompressionError::InvalidData(
            "PT length count is out of range",
        ));
    }
    let mut lengths = vec![0_u8; symbol_count];
    let mut index = 0;
    while index < number {
        let mut length = reader.read_bits(3)? as u8;
        if length == 7 {
            while reader.read_bits(1)? != 0 {
                length = length
                    .checked_add(1)
                    .ok_or(EfiCompressionError::InvalidData("PT code length overflow"))?;
                if length > MAX_CODE_LENGTH as u8 {
                    return Err(EfiCompressionError::InvalidData(
                        "PT code length exceeds 16 bits",
                    ));
                }
            }
        }
        lengths[index] = length;
        index += 1;
        if special == Some(index) {
            index = (index + reader.read_bits(2)? as usize).min(symbol_count);
        }
    }
    Huffman::from_lengths(&lengths)
}

fn read_char_lengths(
    reader: &mut BitReader<'_>,
    extra: &Huffman,
) -> Result<Huffman, EfiCompressionError> {
    let number = reader.read_bits(CBIT)? as usize;
    if number == 0 {
        let symbol = reader.read_bits(CBIT)? as usize;
        return Huffman::single(symbol, NC);
    }
    if number > NC {
        return Err(EfiCompressionError::InvalidData(
            "character length count is out of range",
        ));
    }
    let mut lengths = vec![0_u8; NC];
    let mut index = 0;
    while index < number {
        let symbol = extra.decode(reader)? as usize;
        if symbol <= 2 {
            let run = match symbol {
                0 => 1,
                1 => reader.read_bits(4)? as usize + 3,
                _ => reader.read_bits(CBIT)? as usize + 20,
            };
            if index + run > number {
                return Err(EfiCompressionError::InvalidData(
                    "character zero run exceeds its table",
                ));
            }
            index += run;
        } else {
            let length = symbol - 2;
            if length > MAX_CODE_LENGTH {
                return Err(EfiCompressionError::InvalidData(
                    "character code length exceeds 16 bits",
                ));
            }
            lengths[index] = length as u8;
            index += 1;
        }
    }
    Huffman::from_lengths(&lengths)
}

#[derive(Clone, Debug)]
struct HuffmanEncoding {
    lengths: Vec<u8>,
    codes: Vec<u16>,
    single: Option<usize>,
}

impl HuffmanEncoding {
    fn write_symbol(
        &self,
        writer: &mut BitWriter,
        symbol: usize,
    ) -> Result<(), EfiCompressionError> {
        if self.single == Some(symbol) {
            return Ok(());
        }
        let length = *self
            .lengths
            .get(symbol)
            .ok_or(EfiCompressionError::InvalidData("symbol is out of range"))?;
        if length == 0 {
            return Err(EfiCompressionError::InvalidData(
                "symbol has no Huffman code",
            ));
        }
        writer.put(length, self.codes[symbol] as u32);
        Ok(())
    }
}

fn build_huffman(frequencies: &[u32]) -> Result<HuffmanEncoding, EfiCompressionError> {
    let active: Vec<_> = frequencies
        .iter()
        .enumerate()
        .filter_map(|(symbol, frequency)| (*frequency != 0).then_some(symbol))
        .collect();
    if active.len() <= 1 {
        let symbol = active.first().copied().unwrap_or(0);
        return Ok(HuffmanEncoding {
            lengths: vec![0; frequencies.len()],
            codes: vec![0; frequencies.len()],
            single: Some(symbol),
        });
    }

    let mut node_frequencies = vec![0_u32; frequencies.len() * 2 - 1];
    node_frequencies[..frequencies.len()].copy_from_slice(frequencies);
    let mut left = vec![usize::MAX; node_frequencies.len()];
    let mut right = vec![usize::MAX; node_frequencies.len()];
    let mut heap = BinaryHeap::new();
    for symbol in active {
        heap.push(Reverse((frequencies[symbol], symbol)));
    }
    let mut sorted_leaves = Vec::new();
    let mut available = frequencies.len();
    while heap.len() > 1 {
        let Reverse((left_frequency, left_node)) = heap.pop().expect("two heap entries");
        let Reverse((right_frequency, right_node)) = heap.pop().expect("second heap entry");
        if left_node < frequencies.len() {
            sorted_leaves.push(left_node);
        }
        if right_node < frequencies.len() {
            sorted_leaves.push(right_node);
        }
        left[available] = left_node;
        right[available] = right_node;
        node_frequencies[available] = left_frequency + right_frequency;
        heap.push(Reverse((node_frequencies[available], available)));
        available += 1;
    }
    let root = heap.pop().expect("combined Huffman root").0.1;
    let mut length_counts = [0_usize; MAX_CODE_LENGTH + 1];
    let mut stack = vec![(root, 0_usize)];
    while let Some((node, depth)) = stack.pop() {
        if node < frequencies.len() {
            length_counts[depth.min(MAX_CODE_LENGTH)] += 1;
        } else {
            stack.push((left[node], depth + 1));
            stack.push((right[node], depth + 1));
        }
    }

    let mut capacity: usize = (1..=MAX_CODE_LENGTH)
        .map(|length| length_counts[length] << (MAX_CODE_LENGTH - length))
        .sum();
    while capacity > 1 << MAX_CODE_LENGTH {
        if length_counts[MAX_CODE_LENGTH] == 0 {
            return Err(EfiCompressionError::InvalidData(
                "cannot limit Huffman code lengths",
            ));
        }
        length_counts[MAX_CODE_LENGTH] -= 1;
        let Some(shorter) = (1..MAX_CODE_LENGTH)
            .rev()
            .find(|length| length_counts[*length] != 0)
        else {
            return Err(EfiCompressionError::InvalidData(
                "cannot rebalance Huffman code lengths",
            ));
        };
        length_counts[shorter] -= 1;
        length_counts[shorter + 1] += 2;
        capacity -= 1;
    }
    if capacity != 1 << MAX_CODE_LENGTH {
        return Err(EfiCompressionError::InvalidData(
            "Huffman code space is incomplete",
        ));
    }

    let mut lengths = vec![0_u8; frequencies.len()];
    let mut leaf = 0;
    for length in (1..=MAX_CODE_LENGTH).rev() {
        for _ in 0..length_counts[length] {
            let symbol = *sorted_leaves
                .get(leaf)
                .ok_or(EfiCompressionError::InvalidData(
                    "Huffman leaf ordering is incomplete",
                ))?;
            lengths[symbol] = length as u8;
            leaf += 1;
        }
    }
    if leaf != sorted_leaves.len() {
        return Err(EfiCompressionError::InvalidData(
            "Huffman leaf count does not match its tree",
        ));
    }
    let codes = canonical_codes(&lengths)?;
    Ok(HuffmanEncoding {
        lengths,
        codes,
        single: None,
    })
}

fn canonical_codes(lengths: &[u8]) -> Result<Vec<u16>, EfiCompressionError> {
    let mut counts = [0_u32; MAX_CODE_LENGTH + 1];
    for length in lengths {
        if *length as usize > MAX_CODE_LENGTH {
            return Err(EfiCompressionError::InvalidData(
                "Huffman code length exceeds 16 bits",
            ));
        }
        if *length != 0 {
            counts[*length as usize] += 1;
        }
    }
    let mut next = [0_u32; MAX_CODE_LENGTH + 1];
    let mut code = 0_u32;
    for length in 1..=MAX_CODE_LENGTH {
        code = (code + counts[length - 1]) << 1;
        next[length] = code;
    }
    if code + counts[MAX_CODE_LENGTH] != 1 << MAX_CODE_LENGTH {
        return Err(EfiCompressionError::InvalidData(
            "Huffman lengths do not fill the code space",
        ));
    }
    let mut codes = vec![0_u16; lengths.len()];
    for (symbol, length) in lengths.iter().copied().enumerate() {
        if length != 0 {
            codes[symbol] = next[length as usize] as u16;
            next[length as usize] += 1;
        }
    }
    Ok(codes)
}

#[derive(Clone, Debug)]
struct Huffman {
    single: Option<u16>,
    counts: [u16; MAX_CODE_LENGTH + 1],
    first_codes: [u32; MAX_CODE_LENGTH + 1],
    first_indices: [usize; MAX_CODE_LENGTH + 1],
    symbols: Vec<u16>,
}

impl Huffman {
    fn single(symbol: usize, symbol_count: usize) -> Result<Self, EfiCompressionError> {
        if symbol >= symbol_count {
            return Err(EfiCompressionError::InvalidData(
                "single Huffman symbol is out of range",
            ));
        }
        Ok(Self {
            single: Some(symbol as u16),
            counts: [0; MAX_CODE_LENGTH + 1],
            first_codes: [0; MAX_CODE_LENGTH + 1],
            first_indices: [0; MAX_CODE_LENGTH + 1],
            symbols: Vec::new(),
        })
    }

    fn from_lengths(lengths: &[u8]) -> Result<Self, EfiCompressionError> {
        let codes = canonical_codes(lengths)?;
        let mut counts = [0_u16; MAX_CODE_LENGTH + 1];
        for length in lengths {
            if *length != 0 {
                counts[*length as usize] += 1;
            }
        }
        let mut first_codes = [0_u32; MAX_CODE_LENGTH + 1];
        let mut first_indices = [0_usize; MAX_CODE_LENGTH + 1];
        let mut code = 0_u32;
        let mut index = 0;
        for length in 1..=MAX_CODE_LENGTH {
            code = (code + u32::from(counts[length - 1])) << 1;
            first_codes[length] = code;
            first_indices[length] = index;
            index += counts[length] as usize;
        }
        let mut symbols: Vec<_> = lengths
            .iter()
            .enumerate()
            .filter_map(|(symbol, length)| (*length != 0).then_some(symbol as u16))
            .collect();
        symbols.sort_by_key(|symbol| (lengths[*symbol as usize], codes[*symbol as usize]));
        Ok(Self {
            single: None,
            counts,
            first_codes,
            first_indices,
            symbols,
        })
    }

    fn decode(&self, reader: &mut BitReader<'_>) -> Result<u16, EfiCompressionError> {
        if let Some(symbol) = self.single {
            return Ok(symbol);
        }
        let mut code = 0_u32;
        for length in 1..=MAX_CODE_LENGTH {
            code = (code << 1) | reader.read_bits(1)?;
            let delta = code.wrapping_sub(self.first_codes[length]);
            if delta < u32::from(self.counts[length]) {
                return self
                    .symbols
                    .get(self.first_indices[length] + delta as usize)
                    .copied()
                    .ok_or(EfiCompressionError::InvalidData(
                        "Huffman symbol index is out of range",
                    ));
            }
        }
        Err(EfiCompressionError::InvalidData(
            "Huffman code is not in its table",
        ))
    }
}

#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    current: u8,
    used: u8,
}

impl BitWriter {
    fn put(&mut self, length: u8, value: u32) {
        for shift in (0..length).rev() {
            self.current = (self.current << 1) | ((value >> shift) as u8 & 1);
            self.used += 1;
            if self.used == 8 {
                self.bytes.push(self.current);
                self.current = 0;
                self.used = 0;
            }
        }
    }

    fn finish(mut self) -> Vec<u8> {
        if self.used != 0 {
            self.current <<= 8 - self.used;
            self.bytes.push(self.current);
        }
        self.bytes
    }
}

struct BitReader<'a> {
    bytes: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, bit: 0 }
    }

    fn read_bits(&mut self, length: u8) -> Result<u32, EfiCompressionError> {
        if self.bit + length as usize > self.bytes.len() * 8 {
            return Err(EfiCompressionError::InputTooShort);
        }
        let mut value = 0_u32;
        for _ in 0..length {
            value = (value << 1) | u32::from((self.bytes[self.bit / 8] >> (7 - self.bit % 8)) & 1);
            self.bit += 1;
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EFI_HELLO_WORLD: &[u8] = &[
        0x18, 0, 0, 0, 0x0d, 0, 0, 0, 0x00, 0x0d, 0x3a, 0x51, 0x8d, 0x1c, 0xf8, 0x19, 0x4b, 0xdc,
        0x07, 0x9b, 0x99, 0xd9, 0x3f, 0x0c, 0x10, 0x06, 0xb0, 0x99, 0x5d, 0x3c, 0x56, 0x00,
    ];
    const TIANO_HELLO: &[u8] = &[
        25, 0, 0, 0, 13, 0, 0, 0, 0, 13, 59, 78, 72, 225, 193, 148, 59, 192, 241, 17, 40, 8, 22,
        206, 144, 3, 19, 112, 86, 241, 249, 96, 0,
    ];
    const EFI_SINGLE_A: &[u8] = &[
        8, 0, 0, 0, 1, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0x04, 0x10, 0x00, 0x00,
    ];
    const EFI_REPEATED_A: &[u8] = &[
        11, 0, 0, 0, 32, 0, 0, 0, 0x00, 0x02, 0x20, 0x04, 0x31, 0xd0, 0xb6, 0x63, 0x40, 0x10, 0x00,
    ];

    #[test]
    fn decodes_reference_edk2_compatible_vectors() {
        assert_eq!(
            efi_decompress(EFI_HELLO_WORLD, EfiCompression::EfiStandard).unwrap(),
            b"Hello, World!"
        );
        assert_eq!(
            efi_decompress(TIANO_HELLO, EfiCompression::Tiano).unwrap(),
            b"Hello, Tiano!"
        );
    }

    #[test]
    fn encodes_reference_edk2_compatible_vectors() {
        assert_eq!(
            efi_compress(b"A", EfiCompression::EfiStandard).unwrap(),
            EFI_SINGLE_A
        );
        assert_eq!(
            efi_compress(&[b'A'; 32], EfiCompression::EfiStandard).unwrap(),
            EFI_REPEATED_A
        );
    }

    #[test]
    fn round_trips_literals_matches_and_multiple_blocks() {
        let mut fixture = Vec::new();
        for index in 0..80_000_u32 {
            fixture.push((index.wrapping_mul(73).wrapping_add(index >> 7) & 0xff) as u8);
        }
        fixture.extend(std::iter::repeat_n(0xa5, 4096));

        for kind in [EfiCompression::EfiStandard, EfiCompression::Tiano] {
            let compressed = efi_compress(&fixture, kind).unwrap();
            assert_eq!(efi_decompress(&compressed, kind).unwrap(), fixture);
            assert_eq!(efi_compress(&fixture, kind).unwrap(), compressed);
        }
    }

    #[test]
    fn handles_empty_and_tiny_inputs() {
        for kind in [EfiCompression::EfiStandard, EfiCompression::Tiano] {
            for input in [&[][..], &[0][..], b"A", b"AAAA", b"Hello, firmware!"] {
                let compressed = efi_compress(input, kind).unwrap();
                assert_eq!(efi_decompress(&compressed, kind).unwrap(), input);
            }
        }
    }

    #[test]
    fn rejects_malformed_sizes_and_positions() {
        assert_eq!(
            efi_decompress(&[0; 7], EfiCompression::EfiStandard),
            Err(EfiCompressionError::InputTooShort)
        );
        let mut invalid = EFI_HELLO_WORLD.to_vec();
        invalid[..4].copy_from_slice(&100_u32.to_le_bytes());
        assert!(matches!(
            efi_decompress(&invalid, EfiCompression::EfiStandard),
            Err(EfiCompressionError::InvalidData(_))
        ));
    }
}
