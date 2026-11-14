#!/usr/bin/env python3
# Audio Leveler - Copyright (C) 2026 G Hancox. Created by G Hancox, built with Claude. Licensed under the GNU GPL v2.
"""
Audio Leveler: read and change an MP3's Title and Artist (its ID3 tag).

FPP shows these while a song plays (and FM transmitter plugins can send them
as RDS text). Only the tag at the front of the file is rewritten, plus the old
ID3v1 tag at the end when there is one; every byte of audio, including the
gapless/timing header, stays exactly as it was. Every other part of the tag
(cover art, album, year...) is kept as is.

When the new info fits in the tag's existing spare room (most tags have some),
the file stays the same size, so FPP's Normalize setting and Audio Leveler's
measurements for the song stay valid. Otherwise the tag grows, with room to
spare for next time, and write_tags() reports the new size.

No third-party modules: FPP doesn't ship any tag library for Python.
"""

import os
import shutil
import struct

ID3V1_GENRE_UNKNOWN = 255
NEW_PADDING = 2048


class TagError(Exception):
    pass


def _syncsafe(b):
    return (b[0] & 0x7f) << 21 | (b[1] & 0x7f) << 14 | (b[2] & 0x7f) << 7 | (b[3] & 0x7f)


def _to_syncsafe(n):
    if n >= 1 << 28:
        raise TagError("tag too big")
    return bytes([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])


def _decode_text(data):
    """An ID3v2 text frame's value (several values joined with '/')."""
    if not data:
        return ""
    enc, raw = data[0], data[1:]
    try:
        if enc == 0:
            s = raw.decode("latin-1")
        elif enc == 1:
            s = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-16-le")
        elif enc == 2:
            s = raw.decode("utf-16-be")
        elif enc == 3:
            s = raw.decode("utf-8")
        else:
            return ""
    except UnicodeDecodeError:
        s = raw.decode(("latin-1", "utf-16-le", "utf-16-be", "utf-8")[min(enc, 3)], "replace")
    parts = [p.strip() for p in s.split("\x00") if p.strip()]
    return " / ".join(parts)


def _encode_text(value, major):
    if major >= 4:
        return b"\x03" + value.encode("utf-8")
    try:
        return b"\x00" + value.encode("latin-1")
    except UnicodeEncodeError:
        return b"\x01" + value.encode("utf-16")  # with a byte-order mark


def _read_head(f):
    """(major, flags, tag_end, frames_start, frames_end) or None when there's no ID3v2 tag."""
    f.seek(0)
    h = f.read(10)
    if len(h) < 10 or h[:3] != b"ID3" or h[3] not in (2, 3, 4) or any(b & 0x80 for b in h[6:10]):
        return None
    major, flags = h[3], h[5]
    size = _syncsafe(h[6:10])
    footer = 10 if (major == 4 and flags & 0x10) else 0
    start = 10
    if flags & 0x40 and major >= 3:
        x = f.read(6)
        if len(x) < 6:
            return None
        if major == 4:
            start += _syncsafe(x[:4])
        else:
            start += 4 + struct.unpack(">I", x[:4])[0]
    return major, flags, 10 + size + footer, start, 10 + size


def _frames(blob, major):
    """[(id, flags, data)] for a v2.3/2.4 frame area."""
    out, i = [], 0
    while i + 10 <= len(blob):
        fid = blob[i:i + 4]
        if fid[:1] == b"\x00" or not all(48 <= c <= 57 or 65 <= c <= 90 for c in fid):
            break  # padding
        n = _syncsafe(blob[i + 4:i + 8]) if major == 4 else struct.unpack(">I", blob[i + 4:i + 8])[0]
        if i + 10 + n > len(blob):
            break
        out.append((fid.decode("ascii"), blob[i + 8:i + 10], blob[i + 10:i + 10 + n]))
        i += 10 + n
    return out


def _frames22(blob):
    out, i = [], 0
    while i + 6 <= len(blob):
        fid = blob[i:i + 3]
        if fid[:1] == b"\x00":
            break
        n = int.from_bytes(blob[i + 3:i + 6], "big")
        if i + 6 + n > len(blob):
            break
        out.append((fid.decode("latin-1"), b"", blob[i + 6:i + 6 + n]))
        i += 6 + n
    return out


def _v1(f):
    """(title, artist) from an ID3v1 tag at the end, or None."""
    try:
        f.seek(-128, os.SEEK_END)
    except OSError:
        return None
    t = f.read(128)
    if t[:3] != b"TAG":
        return None
    clean = lambda b: b.split(b"\x00")[0].decode("latin-1").strip()
    return clean(t[3:33]), clean(t[33:63])


def is_mp3_audio(f, at):
    """True when MPEG audio starts at offset 'at' (after any zero padding): not, say, an M4A renamed .mp3."""
    f.seek(at)
    d = f.read(4096).lstrip(b"\x00")
    return len(d) >= 4 and d[0] == 0xFF and (d[1] & 0xE0) == 0xE0 and (d[1] >> 1) & 3 != 0


def read_tags(path):
    """{"title", "artist", "version"} the way FPP reads them: ID3v2 first, then ID3v1."""
    title = artist = ""
    version = ""
    with open(path, "rb") as f:
        head = _read_head(f)
        if head:
            major, flags, tag_end, start, end = head
            version = "2.%d" % major
            f.seek(start)
            blob = f.read(max(0, end - start))
            if not (flags & 0x80):  # whole-tag unsynchronisation: text frames rarely affected, but skip
                frames = _frames22(blob) if major == 2 else _frames(blob, major)
                names = ("TT2", "TP1") if major == 2 else ("TIT2", "TPE1")
                for fid, fl, data in frames:
                    if major == 4 and fl[1:2] and fl[1] & 0x0f:
                        continue  # compressed/encrypted/unsynchronised frame
                    if fid == names[0] and not title:
                        title = _decode_text(data)
                    elif fid == names[1] and not artist:
                        artist = _decode_text(data)
        v1 = _v1(f)
        if v1:
            version = version or "1"
            title = title or v1[0]
            artist = artist or v1[1]
    return {"title": title, "artist": artist, "version": version}


def _frame_bytes(fid, data, major):
    n = len(data)
    size = _to_syncsafe(n) if major == 4 else struct.pack(">I", n)
    return fid.encode("ascii") + size + b"\x00\x00" + data


def write_tags(path, title, artist, tmp_path=None):
    """
    Set Title and Artist (an empty value removes it). Returns
    {"resized": bool, "size": new size}. The file is replaced in one step
    (written beside it, then renamed), so a song that is playing keeps playing;
    its date is kept so nothing treats it as a new upload.
    """
    title = (title or "").strip()
    artist = (artist or "").strip()
    st = os.stat(path)
    with open(path, "rb") as f:
        head = _read_head(f)
        if head and head[0] == 2:
            raise TagError("this MP3 has a very old tag (ID3v2.2); fix its info on your computer")
        if head and head[1] & 0x80:
            raise TagError("this MP3's tag is stored in an unusual way; fix its info on your computer")
        if head:
            major, flags, tag_end, start, end = head
            f.seek(start)
            frames = _frames(f.read(max(0, end - start)), major)
            room = tag_end - 10 - (10 if (major == 4 and flags & 0x10) else 0)
        else:
            major, flags, tag_end, frames, room = 3, 0, 0, [], -1
        if not is_mp3_audio(f, tag_end):
            raise TagError("this file isn't really an MP3 (it's another format named .mp3), so its info can't be changed here")
        has_v1 = _v1(f) is not None

    keep = [(i, fl, d) for i, fl, d in frames if i not in ("TIT2", "TPE1")]
    new = []
    if title:
        new.append(_frame_bytes("TIT2", _encode_text(title, major), major))
    if artist:
        new.append(_frame_bytes("TPE1", _encode_text(artist, major), major))
    body = b"".join(new) + b"".join(_frame_bytes(i, d, major)[:8] + fl + d for i, fl, d in keep)

    footer = major == 4 and bool(flags & 0x10)
    if footer:
        size = len(body)  # a tag with a footer has no padding
    elif len(body) <= room:
        size = room       # fits in the spare room: the file keeps its size
    else:
        size = len(body) + NEW_PADDING
    body += b"\x00" * (size - len(body))
    new_flags = flags & ~0xC0  # no extended header, never unsynchronised
    tag = b"ID3" + bytes([major, 0, new_flags]) + _to_syncsafe(size) + body
    if footer:
        tag += b"3DI" + bytes([major, 0, new_flags]) + _to_syncsafe(size)

    tmp = tmp_path or (path + ".tagging")
    audio_len = st.st_size - tag_end - (128 if has_v1 else 0)
    try:
        with open(path, "rb") as src, open(tmp, "wb") as dst:
            dst.write(tag)
            src.seek(tag_end)
            shutil.copyfileobj(src, dst, 1 << 20)
            if has_v1:
                dst.seek(-125, os.SEEK_END)
                dst.write(title.encode("latin-1", "replace")[:30].ljust(30, b"\x00"))
                dst.write(artist.encode("latin-1", "replace")[:30].ljust(30, b"\x00"))
        # Check before replacing: the audio is byte-for-byte the same and the
        # new info reads back.
        with open(path, "rb") as a, open(tmp, "rb") as b:
            a.seek(tag_end)
            b.seek(len(tag))
            left = audio_len
            while left > 0:
                n = min(left, 1 << 20)
                if a.read(n) != b.read(n):
                    raise TagError("check failed: the audio would have changed")
                left -= n
            if has_v1:
                x, y = a.read(128), b.read(128)
                if x[:3] != y[:3] or x[63:] != y[63:]:
                    raise TagError("check failed: the old ID3v1 tag would have changed")
            if b.read(1):
                raise TagError("check failed: the file would have grown at the end")
        back = read_tags(tmp)
        if back["title"] != title or back["artist"] != artist:
            raise TagError("check failed: the new info didn't read back")
        shutil.copymode(path, tmp)
        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except OSError:
            pass
        os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    new_size = os.path.getsize(path)
    return {"resized": new_size != st.st_size, "size": new_size, "oldSize": st.st_size}
