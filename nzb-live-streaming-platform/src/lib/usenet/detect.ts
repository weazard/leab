/** Content type detection by magic bytes + extension, and browser mime mapping. */

export type MediaKind = "video" | "audio" | "image" | "subtitle" | "text" | "pdf" | "archive" | "par2" | "other";

export interface Detected {
  kind: MediaKind;
  ext: string;
  mime: string;
  /** what the browser should be told — some containers play under a different label */
  browserMime: string;
  label: string;
  playable: boolean;
}

const EXT: Record<string, [MediaKind, string, string?]> = {
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  mov: ["video", "video/quicktime", "video/mp4"],
  mkv: ["video", "video/x-matroska", "video/webm"],
  webm: ["video", "video/webm"],
  avi: ["video", "video/x-msvideo"],
  wmv: ["video", "video/x-ms-wmv"],
  ts: ["video", "video/mp2t"],
  m2ts: ["video", "video/mp2t"],
  mpg: ["video", "video/mpeg"],
  mpeg: ["video", "video/mpeg"],
  flv: ["video", "video/x-flv"],
  ogv: ["video", "video/ogg"],
  "3gp": ["video", "video/3gpp"],
  mp3: ["audio", "audio/mpeg"],
  flac: ["audio", "audio/flac"],
  m4a: ["audio", "audio/mp4"],
  aac: ["audio", "audio/aac"],
  ogg: ["audio", "audio/ogg"],
  opus: ["audio", "audio/ogg"],
  wav: ["audio", "audio/wav"],
  wma: ["audio", "audio/x-ms-wma"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  png: ["image", "image/png"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  bmp: ["image", "image/bmp"],
  srt: ["subtitle", "application/x-subrip"],
  vtt: ["subtitle", "text/vtt"],
  ass: ["subtitle", "text/plain"],
  ssa: ["subtitle", "text/plain"],
  sub: ["subtitle", "text/plain"],
  idx: ["subtitle", "text/plain"],
  nfo: ["text", "text/plain; charset=utf-8"],
  txt: ["text", "text/plain; charset=utf-8"],
  md: ["text", "text/plain; charset=utf-8"],
  sfv: ["text", "text/plain; charset=utf-8"],
  pdf: ["pdf", "application/pdf"],
  epub: ["other", "application/epub+zip"],
  cbz: ["archive", "application/zip"],
  rar: ["archive", "application/vnd.rar"],
  zip: ["archive", "application/zip"],
  "7z": ["archive", "application/x-7z-compressed"],
  par2: ["par2", "application/x-par2"],
  iso: ["other", "application/x-iso9660-image"],
};

const BROWSER_PLAYABLE = new Set([
  "mp4", "m4v", "mov", "mkv", "webm", "ogv", "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav",
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "srt", "vtt", "nfo", "txt", "md", "sfv", "pdf", "ass", "ssa",
]);

function magicExt(h: Uint8Array): string | null {
  const s = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) if (h[off + i] !== str.charCodeAt(i)) return false;
    return true;
  };
  if (h.length < 12) return null;
  if (s(0, "Rar!\x1a\x07")) return "rar";
  if (s(0, "PK\x03\x04")) return "zip";
  if (s(0, "PAR2\0PKT")) return "par2";
  if (s(0, "7z\xbc\xaf\x27\x1c")) return "7z";
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) {
    // EBML: webm vs matroska via DocType
    const head = Array.from(h.subarray(0, 64), (b) => String.fromCharCode(b)).join("");
    return head.includes("webm") ? "webm" : "mkv";
  }
  if (s(4, "ftyp")) {
    const brand = String.fromCharCode(h[8], h[9], h[10], h[11]);
    if (brand.startsWith("qt")) return "mov";
    if (brand.startsWith("M4A")) return "m4a";
    if (brand.startsWith("3gp")) return "3gp";
    return "mp4";
  }
  if (s(0, "RIFF")) {
    if (s(8, "AVI ")) return "avi";
    if (s(8, "WAVE")) return "wav";
    if (s(8, "WEBP")) return "webp";
  }
  if (s(0, "ID3") || (h[0] === 0xff && (h[1] & 0xe6) === 0xe2 && (h[1] & 0x18) !== 0x08)) return "mp3";
  if (s(0, "fLaC")) return "flac";
  if (s(0, "OggS")) return "ogg";
  if (h[0] === 0x30 && h[1] === 0x26 && h[2] === 0xb2 && h[3] === 0x75) return "wmv";
  if (h[0] === 0x00 && h[1] === 0x00 && h[2] === 0x01 && (h[3] === 0xba || h[3] === 0xb3)) return "mpg";
  if (h[0] === 0x47 && h[188] === 0x47 && h[376] === 0x47) return "ts";
  if (s(0, "FLV")) return "flv";
  if (h[0] === 0x89 && s(1, "PNG")) return "png";
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "jpg";
  if (s(0, "GIF8")) return "gif";
  if (s(0, "BM")) return "bmp";
  if (s(0, "%PDF")) return "pdf";
  if (s(0, "WEBVTT")) return "vtt";
  if (s(0, "[Script Info]")) return "ass";
  return null;
}

export function detect(name: string, head: Uint8Array | null): Detected {
  const extFromName = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "").toLowerCase();
  const m = head ? magicExt(head) : null;
  // Magic wins, except keep the name's ext when they agree on category (e.g. m4v vs mp4)
  let ext = m ?? extFromName;
  if (m && EXT[extFromName] && EXT[extFromName][0] === EXT[m]?.[0] && m !== "rar" && m !== "zip") ext = extFromName;
  if (!m && !EXT[extFromName] && head) {
    // sniff plain text (nfo / srt with no ext)
    let printable = 0;
    const n = Math.min(head.length, 512);
    for (let i = 0; i < n; i++) {
      const b = head[i];
      if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09 || b >= 0x80) printable++;
    }
    if (n > 0 && printable / n > 0.97) ext = /^\d+\s*$/m.test(new TextDecoder().decode(head.subarray(0, 64))) ? "srt" : "txt";
  }
  const info = EXT[ext];
  const kind: MediaKind = info?.[0] ?? "other";
  const mime = info?.[1] ?? "application/octet-stream";
  const browserMime = info?.[2] ?? mime;
  return {
    kind,
    ext,
    mime,
    browserMime,
    label: ext ? ext.toUpperCase() : "BIN",
    playable: BROWSER_PLAYABLE.has(ext),
  };
}
