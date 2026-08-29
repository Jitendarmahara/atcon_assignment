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

export async function extractResumeText(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") return extractPdfText(buffer);
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return extractDocxText(buffer);
  }
  throw new Error(`Unsupported resume mime type: ${mimeType}`);
}
