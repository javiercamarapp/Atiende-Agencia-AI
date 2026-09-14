// Fase 8 — parser CSV real usado por `compras-mx-historico.ts`.
import { describe, expect, it } from "vitest";
import { parseCsv, streamCsvRows } from "../../src/connectors/csv.ts";

async function* chunksOf(text: string, chunkSize: number): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += chunkSize) yield text.slice(i, i + chunkSize);
}

describe("parseCsv (variante en lote)", () => {
  it("alinea filas simples contra el encabezado", async () => {
    const { rows, errors } = await parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { row: 1, values: { a: "1", b: "2", c: "3" } },
      { row: 2, values: { a: "4", b: "5", c: "6" } },
    ]);
  });

  it("respeta campos entre comillas con comas embebidas y comillas escapadas (\"\")", async () => {
    const csv = 'titulo,importe\n"Contrato, con coma y ""comillas""",1234.5\n';
    const { rows, errors } = await parseCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ row: 1, values: { titulo: 'Contrato, con coma y "comillas"', importe: "1234.5" } }]);
  });

  it("respeta un salto de línea DENTRO de un campo entre comillas", async () => {
    const csv = 'titulo,importe\n"linea uno\nlinea dos",100\n';
    const { rows, errors } = await parseCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ row: 1, values: { titulo: "linea uno\nlinea dos", importe: "100" } }]);
  });

  it("reporta (no descarta en silencio) una fila con más columnas que el encabezado", async () => {
    const csv = "a,b\n1,2,3\n4,5\n";
    const { rows, errors } = await parseCsv(csv);
    expect(errors).toEqual([{ row: 1, message: "Fila con 3 columna(s), se esperaban 2 (según el encabezado)." }]);
    expect(rows).toEqual([{ row: 2, values: { a: "4", b: "5" } }]);
  });

  it("procesa la última fila aunque el archivo no termine en salto de línea", async () => {
    const { rows } = await parseCsv("a,b\n1,2");
    expect(rows).toEqual([{ row: 1, values: { a: "1", b: "2" } }]);
  });

  it("maneja CRLF igual que LF", async () => {
    const { rows } = await parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(rows).toEqual([
      { row: 1, values: { a: "1", b: "2" } },
      { row: 2, values: { a: "3", b: "4" } },
    ]);
  });
});

describe("streamCsvRows (variante en streaming) produce EXACTAMENTE lo mismo que parseCsv sin importar dónde caiga el corte de chunk", () => {
  it("un campo entre comillas partido a la mitad por el corte de chunk sigue reconstruyéndose completo", async () => {
    const csv = 'titulo,importe\n"Contrato ABC largo",999.99\n"Otro contrato",50\n';
    for (const chunkSize of [1, 2, 3, 5, 7, 13, 4096]) {
      const rows: unknown[] = [];
      const errors: unknown[] = [];
      for await (const event of streamCsvRows(chunksOf(csv, chunkSize))) {
        if (event.kind === "record") rows.push(event.data);
        else errors.push(event.error);
      }
      expect(errors, `chunkSize=${chunkSize}`).toEqual([]);
      expect(rows, `chunkSize=${chunkSize}`).toEqual([
        { row: 1, values: { titulo: "Contrato ABC largo", importe: "999.99" } },
        { row: 2, values: { titulo: "Otro contrato", importe: "50" } },
      ]);
    }
  });

  it("un CSV truncado dentro de un campo entre comillas reporta un error explícito, nunca silencia el resto del archivo", async () => {
    const csv = 'a,b\n1,2\n"sin cerrar,3';
    const events: unknown[] = [];
    for await (const event of streamCsvRows(chunksOf(csv, 4))) events.push(event);
    expect(events).toEqual([
      { kind: "record", data: { row: 1, values: { a: "1", b: "2" } } },
      { kind: "error", error: { row: 2, message: "CSV truncado: fin de archivo dentro de un campo entre comillas sin cerrar." } },
    ]);
  });
});
