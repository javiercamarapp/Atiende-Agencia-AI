// Cliente del tablero de fijados del Copiloto para apps/web (CHAT-15): conecta `SeccionFijadosCopiloto` de @atiende/ui con las
// rutas reales de apps/api de CUALQUIER vertical (`<baseUrl>` = `.../chat-datos`, el mismo de `crearTransporteCopiloto`).
//
//   GET    <baseUrl>/pins                  -> { disponible, pins }          (403 = rol sin Copiloto)
//   GET    <baseUrl>/pins/:id/resultado    -> re-ejecucion directa (sin modelo) con el alcance ACTUAL del usuario
//   PATCH  <baseUrl>/pins/:id              { compartido }                   (403 = el autor no es owner/admin)
//   DELETE <baseUrl>/pins/:id
//
// Nada se inventa: cualquier fallo se traduce a un `FijadosErrorCliente` con el estado honesto correcto. `fetchImpl` es
// inyectable (las pruebas nunca tocan la red).
import { FijadosErrorCliente, type CopilotoBloque, type CopilotoFuente, type FijadoResultado, type FijadoResumen, type FijadosCliente } from "@atiende/ui";
import { normalizarStatus, type CopilotoTransporteConfig } from "./transporte.ts";

function esObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function falla(res: Response, ctx: "leer" | "compartir"): FijadosErrorCliente {
  // 409 = el Copiloto de plataforma no se usa mientras el superadmin impersona: igual que un rol sin Copiloto, el tablero no se pinta.
  if (res.status === 409) return new FijadosErrorCliente("sin_acceso");
  if (res.status === 403) return new FijadosErrorCliente(ctx === "compartir" ? "sin_permiso" : "sin_acceso");
  if (res.status === 503) return new FijadosErrorCliente("no_disponible");
  return new FijadosErrorCliente("error");
}

export function crearClienteFijados(cfg: CopilotoTransporteConfig): FijadosCliente {
  const conAuth = cfg.conAuth ?? ((hacer: (token: string) => Promise<Response>) => hacer(cfg.token));
  const url = (sufijo = ""): string => `${cfg.baseUrl}/pins${sufijo}`;
  const idUrl = (id: string, sufijo = ""): string => url(`/${encodeURIComponent(id)}${sufijo}`);
  const cabecera = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({ authorization: `Bearer ${token}`, ...extra });

  async function llamar(hacer: (token: string) => Promise<Response>): Promise<Response> {
    try {
      return await conAuth(hacer);
    } catch (e) {
      if ((e instanceof DOMException || e instanceof Error) && e.name === "AbortError") throw e;
      throw new FijadosErrorCliente("error", "No pude conectar con el servidor.");
    }
  }

  return {
    async listar(senal) {
      const res = await llamar((t) => cfg.fetchImpl(url(), { headers: cabecera(t), signal: senal }));
      if (!res.ok) throw falla(res, "leer");
      const json: unknown = await res.json().catch(() => undefined);
      if (!esObjeto(json) || typeof json["disponible"] !== "boolean" || !Array.isArray(json["pins"])) throw new FijadosErrorCliente("error", "Respuesta inválida.");
      const fijados: FijadoResumen[] = [];
      for (const p of json["pins"] as unknown[]) {
        if (!esObjeto(p) || typeof p["id"] !== "string" || typeof p["titulo"] !== "string" || typeof p["herramienta"] !== "string") continue;
        fijados.push({ id: p["id"], titulo: p["titulo"], herramienta: p["herramienta"], compartido: p["compartido"] === true, propio: p["propio"] === true });
      }
      return { disponible: json["disponible"], fijados };
    },

    async resultado(id, senal): Promise<FijadoResultado> {
      const res = await llamar((t) => cfg.fetchImpl(idUrl(id, "/resultado"), { headers: cabecera(t), signal: senal }));
      if (!res.ok) throw falla(res, "leer");
      const json: unknown = await res.json().catch(() => undefined);
      if (!esObjeto(json) || typeof json["id"] !== "string") throw new FijadosErrorCliente("error", "Respuesta inválida.");
      return {
        id: json["id"],
        titulo: typeof json["titulo"] === "string" ? json["titulo"] : "Fijado",
        status: normalizarStatus(json["status"]),
        text: typeof json["text"] === "string" ? json["text"] : "",
        blocks: Array.isArray(json["blocks"]) ? (json["blocks"] as CopilotoBloque[]) : [],
        sources: Array.isArray(json["sources"]) ? (json["sources"] as CopilotoFuente[]) : [],
      };
    },

    async quitar(id) {
      const res = await llamar((t) => cfg.fetchImpl(idUrl(id), { method: "DELETE", headers: cabecera(t) }));
      if (!res.ok) throw falla(res, "leer");
    },

    async compartir(id, compartido) {
      const res = await llamar((t) => cfg.fetchImpl(idUrl(id), { method: "PATCH", headers: cabecera(t, { "content-type": "application/json" }), body: JSON.stringify({ compartido }) }));
      if (!res.ok) throw falla(res, "compartir");
    },
  };
}
