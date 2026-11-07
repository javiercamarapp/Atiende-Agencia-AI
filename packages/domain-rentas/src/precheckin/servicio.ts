// Rn-P3-08 -- orquestacion del pre-check-in publico: genera las claves (hash del codigo, token de un solo uso), llama al repositorio y traduce
// el resultado a un estado que la ruta responde sin revelar si la reserva existe. Sin IO propio ni logs: el codigo y el telefono nunca salen de
// aqui hacia ningun registro.
import { claveIntento, generarToken } from "./claves.ts";
import type { RentasPrecheckinRepository } from "./repository.ts";
import { AVISO_PRECHECKIN_VERSION } from "./tipos.ts";
import type { ResultadoCapturar, ResultadoVerificar } from "./tipos.ts";
import { hashToken } from "./claves.ts";
import type { EntradaCaptura, EntradaVerificacion } from "./validacion.ts";

export async function verificarPrecheckin(repo: RentasPrecheckinRepository, propertyId: string, entrada: EntradaVerificacion, aleatorios?: (n: number) => Buffer): Promise<ResultadoVerificar> {
  const { token, hash } = generarToken(aleatorios);
  const r = await repo.verificar(propertyId, entrada.codigo, entrada.ultimos4, claveIntento(propertyId, entrada.codigo), hash);
  if (!r.disponible) return { estado: "no_disponible" };
  const v = r.valor;
  if (v.resultado === "bloqueado") return { estado: "bloqueado" };
  if (v.resultado !== "ok" || v.tokenExpiraEn === null || v.propiedadNombre === null || v.unidadNombre === null || v.checkIn === null || v.checkOut === null) return { estado: "invalido" };
  return { estado: "ok", token, tokenExpiraEn: v.tokenExpiraEn, propiedadNombre: v.propiedadNombre, unidadNombre: v.unidadNombre, checkIn: v.checkIn, checkOut: v.checkOut, yaCapturado: v.yaCapturado };
}

export async function capturarPrecheckin(repo: RentasPrecheckinRepository, entrada: EntradaCaptura): Promise<ResultadoCapturar> {
  const r = await repo.capturar({
    tokenHash: hashToken(entrada.token),
    correo: entrada.correo,
    whatsapp: entrada.whatsapp,
    aceptaPrivacidad: entrada.aceptaPrivacidad,
    avisoVersion: AVISO_PRECHECKIN_VERSION,
    aceptaReglamento: entrada.aceptaReglamento,
  });
  if (!r.disponible) return { estado: "no_disponible" };
  return { estado: r.valor.resultado };
}
