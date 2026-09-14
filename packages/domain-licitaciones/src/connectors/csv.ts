// Fase 8 — parser CSV real (RFC 4180: campos entre comillas dobles, comillas
// escapadas como `""`, comas/saltos de línea dentro de un campo entre
// comillas). Puerto ADAPTADO (no literal) de `licitaciones/packages/sources/
// src/util/csv.ts` del repo origen, reescrito como un único tokenizador
// carácter-a-carácter compartido por la variante en LOTE (`parseCsv`, recibe
// el texto completo de una sola vez) y la variante en STREAMING
// (`streamCsvRows`, recibe un `AsyncIterable<string>` de chunks YA
// DECODIFICADOS) — a diferencia del origen, que tenía dos implementaciones
// separadas, aquí ambas llaman al MISMO generador interno para que nunca
// diverjan entre sí.

export interface CsvRowError {
  readonly row: number;
  readonly message: string;
}

/** Una fila de datos ya alineada contra el encabezado (mismas claves en cada fila, tomadas de la primera fila del CSV). */
export interface CsvDataRow {
  readonly row: number;
  readonly values: Record<string, string>;
}

export type CsvRowEvent = { kind: "record"; data: CsvDataRow } | { kind: "error"; error: CsvRowError };

/**
 * Tokenizador compartido: consume chunks de texto y produce un evento por
 * CADA fila de DATOS completa, ya alineada contra el encabezado (la primera
 * fila del CSV, consumida internamente — nunca emitida como dato). Es el
 * ÚNICO lugar que conoce el estado de "¿estoy dentro de comillas?", para que
 * una coma o un salto de línea dentro de un campo entre comillas nunca corte
 * la fila a la mitad, incluso cuando el corte de chunk cae justo ahí
 * (memoria acotada: solo retiene el campo/fila en curso, nunca el archivo
 * completo — mismo criterio de streaming que el origen, ronda 3 de
 * corrección de `compras-mx-historical-csv-connector.ts` en el repo origen).
 */
export async function* streamCsvRows(chunks: AsyncIterable<string>): AsyncGenerator<CsvRowEvent> {
  let header: string[] | null = null;
  let dataRowNumber = 0;
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyContentInRecord = false;
  let fieldStartedWithQuote = false;

  function pushField(): void {
    fields.push(field);
    field = "";
    fieldStartedWithQuote = false;
  }

  function* finishRecord(): Generator<CsvRowEvent> {
    pushField();
    if (header === null) {
      header = fields;
    } else {
      dataRowNumber += 1;
      if (fields.length !== header.length) {
        // SR-17 del origen: una fila con MÁS (o menos) columnas que el encabezado se reporta explícitamente, nunca se recorta/rellena en silencio.
        yield { kind: "error", error: { row: dataRowNumber, message: `Fila con ${fields.length} columna(s), se esperaban ${header.length} (según el encabezado).` } };
      } else {
        const values: Record<string, string> = {};
        for (let i = 0; i < header.length; i += 1) values[header[i]!] = fields[i]!;
        yield { kind: "record", data: { row: dataRowNumber, values } };
      }
    }
    fields = [];
    sawAnyContentInRecord = false;
  }

  // Una comilla escapada (`""`) puede caer justo en el borde de dos chunks
  // HTTP distintos -- si la comilla que estamos mirando es el ÚLTIMO
  // carácter del chunk actual mientras estamos DENTRO de un campo entre
  // comillas, no se puede decidir todavía si es el cierre del campo o el
  // primer carácter de un escape `""` sin ver el siguiente chunk. `carry`
  // retiene ESA única comilla, TODAVÍA SIN CONSUMIR (memoria acotada a 1
  // carácter), para resolverla al empezar el siguiente chunk -- a
  // diferencia de una versión anterior de este archivo, aquí NUNCA se
  // reserva un carácter por adelantado antes de recorrer el chunk (eso
  // producía una comilla fantasma duplicada cuando el lookahead dentro del
  // MISMO chunk ya resolvía el par escapado).
  let carry = "";
  for await (const rawChunk of chunks) {
    const chunk = carry + rawChunk;
    carry = "";
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i]!;
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < chunk.length) {
            if (chunk[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            inQuotes = false;
            i += 1;
            continue;
          }
          // Última posición del chunk: no hay forma de saber todavía si es cierre o inicio de escape -- se difiere al siguiente chunk sin consumir nada.
          carry = '"';
          i += 1;
          break;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"' && field.length === 0 && !fieldStartedWithQuote) {
        inQuotes = true;
        fieldStartedWithQuote = true;
        sawAnyContentInRecord = true;
        i += 1;
        continue;
      }
      if (ch === ",") {
        pushField();
        sawAnyContentInRecord = true;
        i += 1;
        continue;
      }
      if (ch === "\r") {
        i += 1;
        continue;
      } // CRLF: el \n que sigue cierra la fila.
      if (ch === "\n") {
        yield* finishRecord();
        i += 1;
        continue;
      }
      field += ch;
      sawAnyContentInRecord = true;
      i += 1;
    }
  }
  // Fin real del input con una comilla pendiente sin resolver: por definición ya no hay más caracteres después, así que es un cierre (nunca puede ser el inicio de un escape sin un segundo carácter).
  if (carry === '"') {
    inQuotes = false;
  }

  if (inQuotes) {
    yield { kind: "error", error: { row: dataRowNumber + 1, message: "CSV truncado: fin de archivo dentro de un campo entre comillas sin cerrar." } };
    return;
  }
  // Última fila sin salto de línea final (archivo sin newline de cierre) — se procesa igual, nunca se descarta en silencio.
  if (field.length > 0 || fields.length > 0 || sawAnyContentInRecord) {
    yield* finishRecord();
  }
}

async function* stringToAsyncIterable(text: string): AsyncGenerator<string> {
  yield text;
}

export interface CsvParseResult {
  readonly rows: readonly CsvDataRow[];
  readonly errors: readonly CsvRowError[];
}

/** Variante en LOTE: recibe el CSV completo como una sola cadena (para llamadores que ya la tienen en memoria — p. ej. pruebas con un fixture pequeño). */
export async function parseCsv(csvText: string): Promise<CsvParseResult> {
  const rows: CsvDataRow[] = [];
  const errors: CsvRowError[] = [];
  for await (const event of streamCsvRows(stringToAsyncIterable(csvText))) {
    if (event.kind === "error") errors.push(event.error);
    else rows.push(event.data);
  }
  return { rows, errors };
}
