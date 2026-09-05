/** Lightweight, dependency-free NZB (XML) parser. */

export interface NzbSegment {
  number: number;
  bytes: number;
  messageId: string;
}

export interface NzbFile {
  index: number;
  subject: string;
  poster: string;
  date: number;
  groups: string[];
  segments: NzbSegment[];
  /** name parsed from the subject line (may be obfuscated) */
  subjectName: string;
  /** sum of encoded segment sizes */
  encodedBytes: number;
}

export interface ParsedNzb {
  meta: Record<string, string>;
  files: NzbFile[];
  password?: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function xmlUnescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isNaN(code) ? m : String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = xmlUnescape(m[2]);
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*'([^']*)'/g)) out[m[1]] ??= xmlUnescape(m[2]);
  return out;
}

/** Extract a filename from a usenet subject line. */
export function nameFromSubject(subject: string): string {
  const q = /"([^"]+)"/.exec(subject);
  if (q) return q[1].trim();
  let s = subject;
  s = s.replace(/\(\d+\/\d+\)/g, "").replace(/\[\d+\/\d+\]/g, "");
  s = s.replace(/\byEnc\b/gi, "").replace(/\s+-\s*$/, "").trim();
  const ext = /([^\s\\/]+\.[A-Za-z0-9]{1,5})\b/.exec(s);
  return (ext ? ext[1] : s).trim() || subject;
}

export function parseNzb(xml: string): ParsedNzb {
  if (!/<nzb[\s>]/i.test(xml)) throw new Error("Not an NZB document (missing <nzb> root)");
  const meta: Record<string, string> = {};
  for (const m of xml.matchAll(/<meta\s+type\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/meta>/gi)) meta[m[1]] = xmlUnescape(m[2].trim());

  const files: NzbFile[] = [];
  for (const fm of xml.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/gi)) {
    const a = attrs(fm[1]);
    const body = fm[2];
    const groups: string[] = [];
    for (const g of body.matchAll(/<group>\s*([^<]+?)\s*<\/group>/gi)) groups.push(xmlUnescape(g[1]));
    const segments: NzbSegment[] = [];
    for (const s of body.matchAll(/<segment\b([^>]*)>\s*([^<]+?)\s*<\/segment>/gi)) {
      const sa = attrs(s[1]);
      segments.push({
        number: parseInt(sa.number ?? "0", 10) || segments.length + 1,
        bytes: parseInt(sa.bytes ?? "0", 10) || 0,
        messageId: xmlUnescape(s[2]).replace(/^<|>$/g, ""),
      });
    }
    segments.sort((x, y) => x.number - y.number);
    // de-duplicate identical segment numbers (some indexers emit dupes)
    const dedup: NzbSegment[] = [];
    for (const s of segments) if (!dedup.length || dedup[dedup.length - 1].number !== s.number) dedup.push(s);
    if (!dedup.length) continue;
    const subject = a.subject ?? "";
    files.push({
      index: files.length,
      subject,
      poster: a.poster ?? "",
      date: parseInt(a.date ?? "0", 10) || 0,
      groups,
      segments: dedup,
      subjectName: nameFromSubject(subject),
      encodedBytes: dedup.reduce((n, s) => n + s.bytes, 0),
    });
  }
  if (!files.length) throw new Error("NZB contains no files");
  return { meta, files, password: meta.password };
}
