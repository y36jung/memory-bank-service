import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { AppError } from '../../lib/errors.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape a cell value for TSV output. TSV has no escape sequences, so any
 * embedded TAB, LF, or CR is replaced with a single space.
 */
function tsvEscape(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  return String(cell).replace(/[\t\n\r]/g, ' ');
}

/**
 * Join an array of cell values into a single TSV row string.
 */
function rowToTsv(row: ReadonlyArray<unknown>): string {
  return row.map(tsvEscape).join('\t');
}

// ---------------------------------------------------------------------------
// CSV extraction
// ---------------------------------------------------------------------------

function extractCsv(buffer: Buffer): string {
  const rows: unknown[][] = parse(buffer, {
    bom: true,
    relax_quotes: true,
  }) as unknown[][];

  return rows.map(rowToTsv).join('\n');
}

// ---------------------------------------------------------------------------
// XLSX extraction
// ---------------------------------------------------------------------------

function extractXlsx(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetChunks: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    const rows: XLSX.CellObject[][] = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: true,
      defval: '',
    }) as XLSX.CellObject[][];

    const tsvRows = rows.map((row) => {
      const cells = (row as unknown[]).map((cell) => {
        if (cell instanceof Date) {
          return cell.toISOString();
        }
        return tsvEscape(cell);
      });
      return cells.join('\t');
    });

    sheetChunks.push(`# Sheet: ${sheetName}\n${tsvRows.join('\n')}`);
  }

  return sheetChunks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Extract text from a CSV or XLSX buffer.
 *
 * CSV: parsed with csv-parse (RFC-4180, relax_quotes) and emitted as TSV.
 * XLSX: every sheet serialised to TSV with a '# Sheet: <name>' header.
 *
 * Throws AppError('UNSUPPORTED_FORMAT', …) for any other MIME type.
 */
export async function extractSpreadsheet(buffer: Buffer, mimeType: string): Promise<string> {
  switch (mimeType) {
    case 'text/csv':
      return extractCsv(buffer);
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return extractXlsx(buffer);
    default:
      throw new AppError('UNSUPPORTED_FORMAT', `Unsupported MIME type: ${mimeType}`);
  }
}
