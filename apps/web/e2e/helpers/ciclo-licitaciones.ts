// Piezas comunes de los viajes e2e del ciclo de licitaciones: rutas, textos de las bases/contrato que se suben, y un cliente
// directo contra la API simulada para PREPARAR el estado de un escenario (con el token de una persona) sin recorrer la UI paso a paso.
// Lo que se afirma sobre la UI siempre se hace con clics reales; esto solo siembra el punto de partida de cada viaje.
import { URL_API } from "./fixtures.ts";
import type { ClienteMock } from "../mock-api/cliente.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";
import type { Rol } from "../mock-api/tipos.ts";

export const BASE = `/licitaciones/${licitaciones.orgSlug}`;
export const TENDER_ID = "tnd-1";
export const TENDER_TITULO = "Rehabilitacion de la avenida Reforma, tramo norte";
export const rutaConvocatoria = (sufijo = ""): string => `${BASE}/convocatorias/${TENDER_ID}${sufijo}`;

/** Bases de la convocatoria: una linea = un requisito (el extractor simulado clasifica por palabras reales de las bases). */
export const TEXTO_BASES = [
  "El licitante acreditara su representacion con poder notarial vigente.",
  "Presentar acta constitutiva y sus modificaciones.",
  "Anexo 1 firmado por el representante legal.",
  "Contar con residente de obra con cedula profesional.",
  "Presentar certificado de seguridad industrial, en su caso.",
  "El precio unitario se presentara en pesos mexicanos.",
].join("\n");

export const CONCEPTO_CON_TARIFA = "Rehabilitacion de carpeta asfaltica por m2";

/** Texto del contrato firmado: el extractor simulado reconoce "Clave: valor". */
export const TEXTO_CONTRATO = ["Numero de contrato: CT-2026-001", "Monto total: 18500000", "Plazo de entrega: 90 dias naturales"].join("\n");

export const CODIGO_TOTP = "123456";

/** Cliente de siembra: llama al API simulada como `rol` de licitaciones (token con el formato del mock). */
export class ApiCiclo {
  constructor(private readonly mock: ClienteMock, private readonly rol: Rol = "owner") {}

  private get token(): string {
    return `mock.${this.mock.escenario}.licitaciones-${this.rol}.1`;
  }

  async llamar(metodo: string, ruta: string, cuerpo?: unknown, cabeceras: Record<string, string> = {}): Promise<unknown> {
    const res = await fetch(`${URL_API}/licitaciones/${licitaciones.propertyId}${ruta}`, {
      method: metodo,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID(), ...cabeceras },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    if (!res.ok) throw new Error(`siembra ${metodo} ${ruta} -> ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  decidirGo() {
    return this.llamar("POST", `/tenders/${TENDER_ID}/go-no-go`, { decision: "go", reasons: ["Encaja con la especialidad de la empresa."] });
  }
  extraerRequisitos(texto = TEXTO_BASES) {
    return this.llamar("POST", `/tenders/${TENDER_ID}/requirements/extract`, { documents: [{ documentId: crypto.randomUUID(), documentLabel: "Bases", publishedAt: "2026-09-20T00:00:00.000Z", contentBase64: Buffer.from(texto).toString("base64"), mimeType: "text/plain", filename: "bases.txt" }] });
  }
  async mapearTodo() {
    for (const topic of ["poder_notarial", "acta_constitutiva", "anexo_3"]) {
      await this.llamar("PUT", `/requirement-mappings/${topic}`, { kind: "document", refKey: topic, statementTemplate: "Se acompaña {value}." });
    }
  }
  crearContrato() {
    return this.llamar("POST", `/tenders/${TENDER_ID}/contract`, {});
  }
  async dejarGanada() {
    await this.decidirGo();
    await this.llamar("POST", `/tenders/${TENDER_ID}/resolution`, { resolution: "won", reason: "Fallo a favor." });
  }
}
