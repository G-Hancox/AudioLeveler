# Audio Leveler - Copyright (C) 2026 G Hancox. Created by G Hancox, built with Claude. Licensed under the GNU GPL v2.
"""
Lossless MP3 volume change, the way MP3Gain does it.

Every MPEG audio layer III frame stores a "global_gain" value for each
granule and channel. The decoder scales that granule's audio by
2 ** (global_gain / 4), so adding or subtracting 1 changes the volume by
exactly 1.505 dB without touching the encoded audio at all: no decode, no
re-encode, no quality loss, and the change is perfectly reversible.

The catch is that volume can only move in those 1.505 dB steps, and it can't
limit peaks, so callers use it only when a plain volume change is enough.

This module only edits a copy (src -> dst). It refuses, rather than guesses,
anything it can't handle with certainty (CRC-protected or free-format
frames, damaged streams), and the caller falls back to re-encoding.
"""

import struct

STEP_DB = 1.505  # 20 * log10(2 ** 0.25)

# A granule's loudest possible sample is about 2 ** ((global_gain - 210) / 4 + 17.4)
# of full scale, so below this value it is quieter than -150 dBFS: far below
# hearing and below what any DAC can reproduce. Encoders leave the odd one of
# these at 0; turning such a granule down is pinned at 0 (as MP3Gain does)
# instead of blocking the whole song.
INAUDIBLE_GAIN = 40

_BITRATES = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],   # MPEG-1 layer III
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],       # MPEG-2 / 2.5 layer III
}
_RATES = {
    3: [44100, 48000, 32000],   # MPEG-1    (version bits 11)
    2: [22050, 24000, 16000],   # MPEG-2    (version bits 10)
    0: [11025, 12000, 8000],    # MPEG-2.5  (version bits 00)
}


class NotLossless(Exception):
    """This file can't be changed losslessly; re-encode instead."""


def _id3v2_size(data):
    if len(data) >= 10 and data[:3] == b"ID3":
        size = 0
        for b in data[6:10]:
            if b & 0x80:
                return 0
            size = (size << 7) | b
        footer = 10 if data[5] & 0x10 else 0
        return 10 + size + footer
    return 0


def _trailing_tags_start(data):
    """Where ID3v1 / APEv2 / Lyrics tags at the end of the file begin."""
    end = len(data)
    if end >= 128 and data[end - 128:end - 125] == b"TAG":
        end -= 128
    if end >= 32 and data[end - 32:end - 24] == b"APETAGEX":
        size, flags = struct.unpack_from("<II", data, end - 32 + 12)
        start = end - size - (32 if flags & 0x80000000 else 0)
        if 0 <= start < end:
            end = start
    if end >= 9 and data[end - 9:end] == b"LYRICS200" and end >= 15:
        try:
            size = int(data[end - 15:end - 9])
            if 0 < size < end:
                end -= size + 15
        except ValueError:
            pass
    return end


def _parse_header(data, pos):
    if pos + 4 > len(data):
        return None
    h = int.from_bytes(data[pos:pos + 4], "big")
    if (h >> 21) & 0x7FF != 0x7FF:
        return None
    ver_bits = (h >> 19) & 3
    layer = (h >> 17) & 3
    if ver_bits == 1 or layer != 1:          # reserved version, or not layer III
        return None
    protected = not ((h >> 16) & 1)
    br_idx = (h >> 12) & 0xF
    sr_idx = (h >> 10) & 3
    if sr_idx == 3 or br_idx == 15:
        return None
    pad = (h >> 9) & 1
    mono = ((h >> 6) & 3) == 3
    mpeg1 = ver_bits == 3
    sr = _RATES[ver_bits][sr_idx]
    br = _BITRATES[1 if mpeg1 else 2][br_idx]
    if br == 0:
        return {"free": True}
    length = (144000 * br // sr if mpeg1 else 72000 * br // sr) + pad
    return {"free": False, "mpeg1": mpeg1, "mono": mono, "protected": protected,
            "length": length, "sr": sr, "ver": ver_bits}


def _layout(hdr):
    """(side-info bytes, bits before the first granule block, granules, block bits)."""
    nch = 1 if hdr["mono"] else 2
    if hdr["mpeg1"]:
        side = 17 if nch == 1 else 32
        prefix = 9 + (5 if nch == 1 else 3) + 4 * nch
        return side, prefix, 2, 59, nch
    side = 9 if nch == 1 else 17
    prefix = 8 + (1 if nch == 1 else 2)
    return side, prefix, 1, 63, nch


def _frames(data):
    """Yield (offset, header) for every audio frame; raise NotLossless on anything odd."""
    start = _id3v2_size(data)
    end = _trailing_tags_start(data)
    pos = start
    first = None
    count = 0
    while pos < end:
        # Songs joined end to end often carry the next part's tag in the
        # middle; step over it like a player does.
        mid_tag = _id3v2_size(data[pos:pos + 10])
        if mid_tag:
            pos += mid_tag
            continue
        if data[pos:pos + 3] == b"TAG" and _parse_header(data, pos + 128) is not None:
            pos += 128
            continue
        hdr = _parse_header(data, pos)
        if hdr is None:
            # A few stray bytes at the very end are common and harmless;
            # anything more means a stream we don't fully understand.
            if end - pos <= 512 and count > 0:
                break
            raise NotLossless("the MP3 stream has damaged or unusual data")
        if hdr["free"]:
            raise NotLossless("free-format MP3")
        if hdr["protected"]:
            raise NotLossless("CRC-protected MP3")
        if first is None:
            first = hdr
        elif (hdr["ver"], hdr["sr"]) != (first["ver"], first["sr"]):
            raise NotLossless("the MP3 changes format part way through")
        if pos + hdr["length"] > end:
            if count > 0 and end - pos <= hdr["length"]:
                break  # truncated final frame; leave it untouched
            raise NotLossless("the MP3 stream is cut short")
        yield pos, hdr
        count += 1
        pos += hdr["length"]
    if count < 10:
        raise NotLossless("too few MP3 frames")


def _is_info_frame(data, pos, hdr):
    """LAME/Xing 'Info'/'Xing' or Fraunhofer 'VBRI' header frame (holds no audio)."""
    side = _layout(hdr)[0]
    tag = data[pos + 4 + side:pos + 8 + side]
    return tag in (b"Xing", b"Info") or data[pos + 36:pos + 40] == b"VBRI"


def _gain_fields(hdr):
    side, prefix, granules, block, nch = _layout(hdr)
    for gr in range(granules):
        for ch in range(nch):
            base = prefix + (gr * nch + ch) * block
            yield base, base + 21  # (part2_3_length bit offset, global_gain bit offset)


def _get(bits, nbits, off, width):
    return (bits >> (nbits - off - width)) & ((1 << width) - 1)


def _set(bits, nbits, off, width, value):
    shift = nbits - off - width
    mask = ((1 << width) - 1) << shift
    return (bits & ~mask) | ((value & ((1 << width) - 1)) << shift)


def headroom(path):
    """
    How many 1.5 dB steps the file can be turned up and down without any
    audio granule's global_gain leaving 0..255. Raises NotLossless if the file
    can't be handled.
    """
    with open(path, "rb") as f:
        data = f.read()
    lo, hi = 255, 0
    for pos, hdr in _frames(data):
        if _is_info_frame(data, pos, hdr):
            continue
        side = _layout(hdr)[0]
        raw = data[pos + 4:pos + 4 + side]
        bits = int.from_bytes(raw, "big")
        n = side * 8
        for p23, gg in _gain_fields(hdr):
            if _get(bits, n, p23, 12) == 0:
                continue  # silent granule; its gain doesn't matter
            g = _get(bits, n, gg, 8)
            hi = max(hi, g)
            if g >= INAUDIBLE_GAIN:
                lo = min(lo, g)
    if hi == 0:
        return 0, 0
    if lo > hi:
        lo = INAUDIBLE_GAIN
    return 255 - hi, lo  # (steps up, steps down)


def apply(src, dst, steps):
    """
    Write a copy of src to dst with the volume changed by steps * 1.505 dB.
    Everything except the gain values is copied byte for byte, including tags
    and the LAME/Xing header (which carries the gapless timing).
    """
    with open(src, "rb") as f:
        data = bytearray(f.read())
    if steps:
        up, down = headroom(src)
        if steps > up or -steps > down:
            raise NotLossless("the change is too large for a lossless MP3 edit")
        for pos, hdr in _frames(data):  # only side info changes, so the walk is unaffected
            if _is_info_frame(data, pos, hdr):
                continue
            side = _layout(hdr)[0]
            a, b = pos + 4, pos + 4 + side
            n = side * 8
            bits = int.from_bytes(data[a:b], "big")
            for p23, gg in _gain_fields(hdr):
                g = _get(bits, n, gg, 8)
                if _get(bits, n, p23, 12) == 0 or g < INAUDIBLE_GAIN:
                    g = max(0, min(255, g + steps))  # silent / inaudible granule: keep it in range
                else:
                    g += steps
                bits = _set(bits, n, gg, 8, g)
            data[a:b] = bits.to_bytes(side, "big")
    with open(dst, "wb") as f:
        f.write(data)


def _crc16(data):
    """CRC-16 (ANSI, LSB first) as used by the LAME tag."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def label_lame_tag(path):
    """
    Make a freshly encoded MP3's gapless information readable by GStreamer,
    which is what FPP plays audio with.

    Every MP3 encoder puts a little silence at the start (the "encoder delay",
    about 25 ms with LAME) and records how much in the LAME tag, so players can
    skip it and the song starts exactly where it did before encoding. ffmpeg
    encodes MP3 with LAME but labels the tag "Lavc..."; GStreamer's MP3 parser
    only reads a tag labelled "LAME", so it plays that silence and the song
    lands 25 ms late against its sequence. This relabels the tag "LAME3.100"
    (the encoder that actually made the audio) and updates the tag's
    checksum. Nothing else in the file changes.

    Returns True if the tag was relabelled, False if it already said LAME.
    Raises RuntimeError if the file doesn't have the expected tag.
    """
    with open(path, "rb") as f:
        data = bytearray(f.read())
    pos = _id3v2_size(data)
    hdr = _parse_header(data, pos)
    if hdr is None or hdr.get("free"):
        raise RuntimeError("no MP3 frame where the gapless tag should be")
    side = _layout(hdr)[0]
    x = pos + 4 + side
    if bytes(data[x:x + 4]) not in (b"Info", b"Xing"):
        raise RuntimeError("the MP3 has no gapless (Info) frame")
    flags = int.from_bytes(data[x + 4:x + 8], "big")
    tag = x + 8 + (4 if flags & 1 else 0) + (4 if flags & 2 else 0) + \
        (100 if flags & 4 else 0) + (4 if flags & 8 else 0)
    frame_end = pos + hdr["length"]
    if tag + 24 > frame_end:
        raise RuntimeError("the MP3's gapless tag is cut short")
    label = bytes(data[tag:tag + 4])
    if label == b"LAME":
        return False
    if label not in (b"Lavc", b"Lavf"):
        raise RuntimeError("unexpected MP3 gapless tag %r" % label)
    data[tag:tag + 9] = b"LAME3.100"
    # LAME's tag checksum covers the frame up to the checksum itself. Older
    # ffmpeg sometimes wrote the tag in a frame too short to hold the checksum
    # (the delay still fits, which is all players read); then there is none
    # to update, and writing one would overwrite the next frame.
    if tag + 36 <= frame_end:
        data[tag + 34:tag + 36] = _crc16(data[pos:tag + 34]).to_bytes(2, "big")
    with open(path, "r+b") as f:
        f.seek(0)
        f.write(data)
    return True
