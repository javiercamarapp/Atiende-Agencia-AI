// Lector CSV (RFC 4180) con limites duros aplicados ANTES de procesar: tamano, filas, columnas y longitud de campo. Sin dependencias,
// sin evaluar nada: es texto plano. Tolera BOM UTF-8, CRLF/LF y campos entre comillas con comas, saltos de linea y comillas dobles.
import { RentasDomainError } from "../../errors.ts";
import { LIMITES_REPORTE } from "./tipos.ts";

export function leerCsv(texto: string): string[][] {
  if (Buffer.byteLength(texto, "utf8") > LIMITES_REPORTE.maxBytes) {
    throw new RentasDomainError("reporte_invalido", `El archivo excede ${LIMITES_REPORTE.maxBytes / (1024 * 1024)} MB.`);
  }
  const s = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let entreComillas = false;
  let hayContenido = false;

  const cerrarCampo = () => {
    if (campo.length > LIMITES_REPORTE.maxLongitudCampo) throw new RentasDomainError("reporte_invalido", "Un campo del archivo excede la longitud permitida.");
    fila.push(campo);
    campo = "";
    if (fila.length > LIMITES_REPORTE.maxColumnas) throw new RentasDomainError("reporte_invalido", "El archivo tiene demasiadas columnas.");
  };
  const cerrarFila = () => {
    cerrarCampo();
    if (fila.length > 1 || fila[0]!.trim() !== "") filas.push(fila);
    fila = [];
    hayContenido = false;
    if (filas.length > LIMITES_REPORTE.maxFilas + 1) throw new RentasDomainError("reporte_invalido", `El archivo excede ${LIMITES_REPORTE.maxFilas} filas.`);
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (entreComillas) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          campo += '"';
          i++;
        } else entreComillas = false;
      } else campo += c;
      continue;
    }
    if (c === '"' && campo === "") {
      entreComillas = true;
      hayContenido = true;
    } else if (c === ",") {
      cerrarCampo();
      hayContenido = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      cerrarFila();
    } else {
      campo += c;
      hayContenido = true;
    }
  }
  if (entreComillas) throw new RentasDomainError("reporte_invalido", "El archivo tiene un campo entre comillas sin cerrar.");
  if (hayContenido || campo !== "" || fila.length > 0) cerrarFila();
  return filas;
}
