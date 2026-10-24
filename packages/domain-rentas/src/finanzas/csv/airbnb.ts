// Rn-P3-06 -- parser del reporte de transacciones de Airbnb (CSV "Transaction history" / historial de transacciones, en ingles).
//
// ESTADO DE VERIFICACION (declarado en el PR): las columnas de abajo estan tomadas de la estructura del export que Airbnb ofrece al
// anfitrion; la fixture `tests/fixtures/pagos/airbnb-transacciones.csv` es ANONIMIZADA y fue armada con esa estructura, NO es un
// export real. Por eso el parser es estricto: localiza las columnas por NOMBRE de encabezado (el orden no importa), exige las
// minimas y, si faltan, rechaza el archivo con un mensaje claro en vez de adivinar. Un export en otro idioma (encabezados
// localizados) tampoco se interpreta: se rechaza como formato no reconocido.
//
// Semantica por tipo de fila:
//   * "Reservation" con monto >= 0 -> linea `reserva`: neto = "Paid out" (lo depositado al anfitrion, ya sin la comision del canal;
//     si esa columna viene vacia se usa "Amount"); bruto = "Gross earnings" cuando existe.
//   * "Payout" -> informativa (la transferencia bancaria que agrupa reservas): se ignora, no es una reserva.
//   * Cualquier otro tipo (resolucion, impuestos retenidos, co-anfitrion, etc.) o un monto negativo -> linea `ajuste`: va a la cola de
//     revision, jamas crea un movimiento solo.
import { RentasDomainError } from "../../errors.ts";
import { leerCsv } from "./lector.ts";
import { centavosDesdeTextoMonto, huellaLinea, LIMITES_REPORTE } from "./tipos.ts";
import type { ErrorFilaReporte, LineaReporteCanal, ResultadoParseoReporte } from "./tipos.ts";

const COLUMNAS_MINIMAS = ["type", "confirmation code", "currency", "paid out"] as const;

function normalizar(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function fechaInequivoca(raw: string): string | null {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  // Solo se interpreta cuando un componente >12 desambigua dia y mes; si no, se deja null (la huella usa el texto crudo).
  let mes: number;
  let dia: number;
  if (a > 12 && b <= 12) {
    dia = a;
    mes = b;
  } else if (b > 12 && a <= 12) {
    mes = a;
    dia = b;
  } else return null;
  return `${m[3]}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

export function parsearReporteAirbnb(texto: string): ResultadoParseoReporte {
  const filas = leerCsv(texto);
  if (filas.length === 0) throw new RentasDomainError("reporte_invalido", "El archivo esta vacio.");
  const encabezado = filas[0]!.map(normalizar);
  const idx = new Map<string, number>();
  encabezado.forEach((h, i) => {
    if (!idx.has(h)) idx.set(h, i);
  });
  const faltantes = COLUMNAS_MINIMAS.filter((c) => !idx.has(c));
  if (faltantes.length > 0) {
    throw new RentasDomainError(
      "reporte_invalido",
      `No se reconoce el formato del reporte de Airbnb: faltan las columnas ${faltantes.map((f) => `"${f}"`).join(", ")}. Descarga el "Historial de transacciones" en CSV con encabezados en ingles.`,
    );
  }
  const col = (fila: string[], nombre: string): string => {
    const i = idx.get(nombre);
    return i === undefined ? "" : (fila[i] ?? "").trim();
  };

  const lineas: LineaReporteCanal[] = [];
  const errores: ErrorFilaReporte[] = [];
  const vistas = new Map<string, number>();
  let ignoradas = 0;

  for (let n = 1; n < filas.length; n++) {
    const fila = filas[n]!;
    const numeroFila = n + 1;
    const tipoOriginal = col(fila, "type");
    const tipo = tipoOriginal.toLowerCase();
    if (tipo === "") {
      errores.push({ fila: numeroFila, motivo: "La fila no tiene tipo." });
      continue;
    }
    if (tipo === "payout") {
      ignoradas++;
      continue;
    }
    const moneda = col(fila, "currency");
    if (!/^[A-Z]{3}$/.test(moneda)) {
      errores.push({ fila: numeroFila, motivo: "Moneda invalida: se esperaba un codigo de 3 letras mayusculas." });
      continue;
    }
    const textoNeto = col(fila, "paid out") !== "" ? col(fila, "paid out") : col(fila, "amount");
    const neto = centavosDesdeTextoMonto(textoNeto);
    if (neto === null) {
      errores.push({ fila: numeroFila, motivo: "Monto invalido o ausente." });
      continue;
    }
    const textoBruto = col(fila, "gross earnings");
    const bruto = textoBruto === "" ? null : centavosDesdeTextoMonto(textoBruto);
    if (textoBruto !== "" && bruto === null) {
      errores.push({ fila: numeroFila, motivo: "Ingreso bruto invalido." });
      continue;
    }
    const codigo = col(fila, "confirmation code").toUpperCase();
    if (codigo !== "" && !/^[A-Z0-9]{1,40}$/.test(codigo)) {
      errores.push({ fila: numeroFila, motivo: "Codigo de confirmacion invalido." });
      continue;
    }
    const tipoLinea: "reserva" | "ajuste" = tipo === "reservation" && neto >= 0 && codigo !== "" ? "reserva" : "ajuste";
    const fechaTexto = col(fila, "date");
    const base = [tipoLinea, tipo, codigo, fechaTexto, String(neto), moneda];
    const clave = base.join("|");
    const ordinal = vistas.get(clave) ?? 0;
    vistas.set(clave, ordinal + 1);
    lineas.push({
      fila: numeroFila,
      tipoLinea,
      codigoConfirmacion: codigo === "" ? null : codigo,
      fecha: fechaInequivoca(fechaTexto),
      moneda,
      montoNetoCentavos: neto,
      montoBrutoCentavos: bruto,
      comisionCanalCentavos: bruto !== null && bruto >= neto ? bruto - neto : null,
      tipoOriginal: tipoOriginal.slice(0, 60),
      huella: huellaLinea("airbnb", [...base, String(ordinal)]),
    });
  }
  if (lineas.length + ignoradas + errores.length === 0) throw new RentasDomainError("reporte_invalido", "El archivo no trae filas de datos.");
  if (lineas.length + errores.length > LIMITES_REPORTE.maxFilas) throw new RentasDomainError("reporte_invalido", "El archivo excede el numero de filas permitido.");
  return { lineas, ignoradas, errores };
}
