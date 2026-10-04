// D-P3-22 -- exportacion CSV de los CFDI del cliente desde su portal. Neutraliza la inyeccion de formulas (una celda que empieza con = + - @ tab o CR se
// antepone con comilla) y entrecomilla lo que lo necesite; CRLF y BOM UTF-8 para que Excel lo abra bien. Montos en pesos con 2 decimales exactos (desde centavos).
import { centavosATexto } from "../libro/poliza.ts";
import type { PortalCfdiVista } from "./types.ts";

function celda(valor: string | number | boolean | null): string {
  const texto = valor === null ? "" : String(valor);
  const seguro = /^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto;
  return /[",\r\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

export const COLUMNAS_CSV_PORTAL = ["Fecha", "Tipo", "Sentido", "UUID", "RFC emisor", "Emisor", "RFC receptor", "Total", "Estado SAT", "Excluido por revision"] as const;

export function cfdiPortalACsv(lista: readonly PortalCfdiVista[]): string {
  const filas = lista.map((c) => [c.fecha, c.tipo, c.direccion ?? "", c.folioFiscal, c.rfcEmisor, c.emisorNombre ?? "", c.rfcReceptor, centavosATexto(c.totalCentavos), c.estadoSat, c.excluido ? "si" : "no"]);
  return `﻿${[COLUMNAS_CSV_PORTAL as readonly string[], ...filas].map((f) => f.map((v) => celda(v)).join(",")).join("\r\n")}\r\n`;
}
