/**
 * Container/codec probe.
 *
 * Usenet releases are usually MKV or MP4 with H.264/HEVC video and AAC, AC3,
 * DTS or TrueHD audio. Browsers only decode a subset of that, and when they
 * can't you get exactly two symptoms: "it won't play at all" (container or
 * video codec) and "plays but there's no sound" (audio codec). Reading the
 * container header up front lets us say so instead of leaving the user staring
 * at a silent video.
 *
 * Everything here is a handful of ranged reads — no downloads.
 */
import type { RandomReader } from "./virtualfile";

export interface CodecInfo {
  container: "matroska" | "webm" | "mp4" | "mpegts" | "avi" | "unknown";
  video: string[];
  audio: string[];
  subtitles: string[];
  /** null = unknown (couldn't parse); false = browser cannot decode this */
  browserVideo: boolean | null;
  browserAudio: boolean | null;
  /** true when the file's moov/metadata is at the end (needs a tail fetch) */
  moovAtEnd?: boolean;
  notes: string[];
}

const td = new TextDecoder("latin1");

const VIDEO_OK = new Set(["avc1", "avc3", "vp09", "av01", "V_MPEG4/ISO/AVC", "V_VP9", "V_AV1", "V_MPEG4/ISO/SP", "V_MPEG4/ISO/ASP", "mp4v"]);
const AUDIO_OK = new Set(["mp4a", "Opus", "A_AAC", "A_OPUS", "A_VORBIS", "A_FLAC", "A_MPEG/L3", "A_PCM/INT/LIT"]);
/** codecs a browser can decode on some platforms only (HEVC needs OS/hardware support) */
const VIDEO_MAYBE = new Set(["hev1", "hvc1", "V_MPEGH/ISO/HEVC"]);

const MKV_CODECS = /V_(?:MPEG4\/ISO\/(?:AVC|SP|ASP|AP)|MPEGH\/ISO\/HEVC|VP8|VP9|AV1|MS\/VFW\/WVC1|THEORA|REAL\/\w+)|A_(?:AAC|AC3|EAC3|DTS|TRUEHD|FLAC|OPUS|VORBIS|MP3|MPEG\/L[123]|PCM\/(?:INT|BIG|FLT)(?:\/(?:LIT|BIG))?|ALAC|WAVPACK4|TTA)|S_(?:TEXT\/(?:UTF8|SSA|ASS|WEBVTT)|VOBSUB|KATE\/\w+)/g;

function uniq(arr: string[]): string[] {
  return [...new Set(arr)];
}

export async function probeCodecs(reader: RandomReader, size: number): Promise<CodecInfo | null> {
  try {
    const headLen = Math.min(size, 2 * 1024 * 1024);
    const head = await reader.read(0, headLen - 1);
    if (head.length < 16) return null;

    // EBML (Matroska / WebM)
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      const text = td.decode(head);
      const docType = /doctype"?\s*[^\x00]*?(matroska|webm)/i.exec(text)?.[1]?.toLowerCase();
      const found = uniq((text.match(MKV_CODECS) ?? []).map((s) => s.replace(/\0.*$/, "")));
      const video = found.filter((c) => c.startsWith("V_"));
      const audio = found.filter((c) => c.startsWith("A_"));
      const subtitles = found.filter((c) => c.startsWith("S_"));
      const info: CodecInfo = {
        container: docType === "webm" ? "webm" : "matroska",
        video,
        audio,
        subtitles,
        browserVideo: video.length ? video.every((c) => VIDEO_OK.has(c) || VIDEO_MAYBE.has(c)) : null,
        browserAudio: audio.length ? audio.every((c) => AUDIO_OK.has(c)) : null,
        notes: [],
      };
      return decorate(info);
    }

    // ISO-BMFF (mp4 / mov / m4v)
    if (td.decode(head.subarray(4, 8)) === "ftyp") {
      const boxes = topLevelBoxes(head);
      let moov = boxes.find((b) => b.type === "moov");
      let moovAtEnd = false;
      if (!moov && size > head.length) {
        // moov at the end: fetch the tail and look for it there
        const tailLen = Math.min(size, 16 * 1024 * 1024);
        const tail = await reader.read(size - tailLen, size - 1);
        moov = topLevelBoxes(tail).find((b) => b.type === "moov");
        moovAtEnd = !!moov;
      }
      const codecs = moov ? parseStsd(Buffer.from(head).subarray(moov.at, moov.at + moov.size)) : parseStsdQuick(head);
      const video = codecs.filter((c) => /^(avc1|avc3|hev1|hvc1|vp09|av01|mp4v|dvh1|dvhe)$/.test(c));
      const audio = codecs.filter((c) => /^(mp4a|ac-3|ec-3|Opus|alac|dtsc|dtsh|dtsl|fLaC|samr|sawb)$/.test(c));
      const info: CodecInfo = {
        container: "mp4",
        video,
        audio,
        subtitles: codecs.filter((c) => /^(tx3g|wvtt|stpp)$/.test(c)),
        browserVideo: video.length ? video.every((c) => VIDEO_OK.has(c) || VIDEO_MAYBE.has(c)) : null,
        browserAudio: audio.length ? audio.every((c) => AUDIO_OK.has(c)) : null,
        moovAtEnd,
        notes: [],
      };
      return decorate(info);
    }

    if (head[0] === 0x47 && (head[188] === 0x47 || head[376] === 0x47)) {
      return decorate({ container: "mpegts", video: ["mpeg2video/h264 (ts)"], audio: [], subtitles: [], browserVideo: null, browserAudio: null, notes: [] });
    }
    if (td.decode(head.subarray(0, 4)) === "RIFF" && td.decode(head.subarray(8, 12)) === "AVI ") {
      return decorate({ container: "avi", video: [], audio: [], subtitles: [], browserVideo: false, browserAudio: false, notes: ["AVI is not supported by browsers"] });
    }
    return null;
  } catch {
    return null;
  }
}

function decorate(info: CodecInfo): CodecInfo {
  if (info.container === "matroska") {
    info.notes.push("Matroska (MKV) playback support varies: Chrome/Edge demux it, Safari and Firefox generally do not.");
  }
  for (const v of info.video) {
    if (VIDEO_MAYBE.has(v)) info.notes.push("HEVC/x265 video: plays only where the browser has OS/hardware support (recent Windows/macOS); elsewhere the video stays black.");
    if (v === "V_MS/VFW/WVC1" || v === "mp4v") info.notes.push("VC-1 / MPEG-4 Part 2 video is not supported by browsers.");
  }
  for (const a of info.audio) {
    if (/^(A_AC3|A_EAC3|ac-3|ec-3)$/.test(a)) info.notes.push("Dolby Digital (AC3/E-AC3) audio: browsers cannot decode it — you will get video with no sound. Use VLC/mpv, or open the stream URL there.");
    if (/^(A_DTS|dtsc|dtsh|dtsl)$/.test(a)) info.notes.push("DTS audio: browsers cannot decode it — video will play silently. Use VLC/mpv for sound.");
    if (/^A_TRUEHD$/.test(a)) info.notes.push("TrueHD audio: not decodable in browsers — no sound.");
  }
  if (info.video.length && info.browserVideo === true && info.audio.length && info.browserAudio === false) {
    info.notes.unshift("Playable video, unsupported audio: expect a silent picture in the browser.");
  }
  return info;
}

interface Box {
  type: string;
  at: number;
  size: number;
}

function topLevelBoxes(buf: Uint8Array): Box[] {
  const out: Box[] = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    let size = new DataView(buf.buffer, buf.byteOffset + p, 4).getUint32(0);
    const type = td.decode(buf.subarray(p + 4, p + 8));
    if (size === 1 && p + 16 <= buf.length) {
      size = Number(new DataView(buf.buffer, buf.byteOffset + p + 8, 8).getBigUint64(0));
    }
    if (!size || size < 8 || p + size > buf.length) break;
    out.push({ type, at: p, size });
    p += size;
  }
  return out;
}

/** Read the `stsd` sample entries out of a moov box. */
function parseStsd(moov: Uint8Array): string[] {
  const idx = td.decode(moov).indexOf("stsd");
  if (idx < 0) return [];
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const count = view.getUint32(idx + 8);
  const out: string[] = [];
  let q = idx + 16;
  for (let i = 0; i < count && q + 8 <= moov.length; i++) {
    const size = view.getUint32(q);
    const type = td.decode(moov.subarray(q + 4, q + 8));
    if (/^(avc1|avc3|hev1|hvc1|vp09|av01|mp4v|mp4a|ac-3|ec-3|Opus|alac|dtsc|dtsh|dtsl|fLaC|tx3g|wvtt|stpp|dvh1|dvhe)$/.test(type)) out.push(type);
    if (!size || size < 8) break;
    q += size;
  }
  return uniq(out);
}

/** Fallback: scan the raw bytes for known sample-entry fourccs. */
function parseStsdQuick(buf: Uint8Array): string[] {
  const text = td.decode(buf);
  const out: string[] = [];
  for (const c of ["avc1", "avc3", "hev1", "hvc1", "vp09", "av01", "mp4a", "ac-3", "ec-3", "Opus"]) {
    if (text.includes(c)) out.push(c);
  }
  return out;
}
