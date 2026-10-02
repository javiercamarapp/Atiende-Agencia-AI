// Extrae el texto visible de un PDF generado con pdf-lib: los flujos de contenido van comprimidos (Flate) y las cadenas
// de los operadores Tj salen como hexadecimal en Latin-1 (WinAnsi); los metadatos (titulo, asunto) van como UTF-16BE
// hexadecimal. Devuelve todo ya decodificado para buscar con `toContain`.
import { inflateSync } from "node:zlib";

export function textoDelPdf(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const partes: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let contenido: string;
    try {
      contenido = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const t of contenido.matchAll(/<([0-9A-Fa-f]{2,})>\s*Tj/g)) partes.push(Buffer.from(t[1]!, "hex").toString("latin1"));
  }
  for (const m of raw.matchAll(/<FEFF([0-9A-Fa-f]+)>/g)) partes.push(Buffer.from(m[1]!, "hex").swap16().toString("utf16le"));
  return partes.join("\n");
}

export function paginasDelPdf(bytes: Uint8Array): number {
  return (Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}
