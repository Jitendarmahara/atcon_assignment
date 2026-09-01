import mammoth from "mammoth";

// pdfjs-dist (Mozilla's actual, actively-maintained PDF engine) rather than
// the abandoned `pdf-parse` wrapper: pdf-parse pins a frozen 2018-era pdf.js
// build that throws "bad XRef entry" on any PDF using cross-reference
// streams - the default output of LibreOffice, Chrome's print-to-PDF, and
// modern Word/Google Docs exports since PDF 1.5. That would silently fail
// resume parsing for a large share of real-world uploads, which is exactly
// the kind of reliability gap this system is supposed to demonstrate care
// about. The "legacy" build runs in plain Node without a DOM or a worker.
async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

  // pdf.js text items carry no embedded newlines - a line of text arrives as
  // several items with no line-break marker of their own. Each item's
  // `hasEOL` flag (set on the line-ending item pdf.js synthesizes) is what
  // actually reconstructs line breaks; joining items with plain spaces
  // instead (a common naive mistake) collapses an entire page into one line
  // and silently breaks every section-header heuristic downstream.
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      if (item.hasEOL) text += "\n";
    }
    text += "\n";
  }
  await doc.destroy();
  return text;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// Some resume-builder export pipelines embed the entire resume's text twice
// in one file - a visibly-rendered layer plus a duplicate (often an
// "ATS-friendly" hidden text layer some tools add deliberately). pdf.js (and
// in principle a similarly-built DOCX) extracts every text-showing operator
// regardless of which layer it belongs to, so the duplication carries
// straight into the raw string. An LLM structurer tends to silently self-heal
// this - it recognizes the content as the same thing twice - but the offline
// heuristic structurer has no semantic understanding and faithfully doubles
// every section (verified against a real resume that hit exactly this:
// every skill, job, and bullet appeared twice in the parsed output).
// Detected by checking whether the document's own opening line reappears
// later in the text - a short line is never trusted as the signal (too easy
// to coincidentally repeat), but a resume's first line is almost always the
// candidate's full name, long and specific enough that a verbatim repeat is
// overwhelmingly more likely to be a duplicated layer than a coincidence.
export function dropRepeatedContent(text: string): string {
  const firstLineEnd = text.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).trim();
  if (firstLine.length < 8) return text;

  const repeatIndex = text.indexOf(firstLine, firstLine.length);
  if (repeatIndex === -1) return text;

  return text.slice(0, repeatIndex).trim();
}

export async function extractResumeText(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") return dropRepeatedContent(await extractPdfText(buffer));
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return dropRepeatedContent(await extractDocxText(buffer));
  }
  throw new Error(`Unsupported resume mime type: ${mimeType}`);
}
