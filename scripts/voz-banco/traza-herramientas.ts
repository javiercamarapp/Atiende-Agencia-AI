// T03: traza de herramientas por turno del cliente + conteo de «crear sin confirmar». Decorador EXTERNO (el modelo lo ve primero): registra lo que el modelo INTENTO, aunque
// la compuerta (decorador interno) lo bloquee. Definicion (BANCO-DE-PRUEBAS 2.4/3.4): un crear es «sin confirmar» si no hay un `confirmar` con exito vigente desde la ultima
// cotizacion, o si se pide en el MISMO turno del cliente en que se cotizo (el cliente aun no pudo decir «si» a ese resumen), o si el turno del cliente no es una afirmacion pura.
import { esAfirmacion } from "../../packages/voice-core/src/llamada/cascada-v2/afirmacion.ts";
import type { ToolCallPedida } from "../../packages/voice-core/src/llamada/sesion.ts";
import { REGLA_PEDIDOS_PM } from "./compuerta-pedidos.ts";
import type { ReglaPedidos } from "./compuerta-pedidos.ts";
import type { EjecutarTool, RegistroHerramienta } from "./tipos.ts";

const BLOQUEOS = new Set(["espera_confirmacion_del_cliente", "resumen_distinto_al_leido", "interrumpido_por_el_cliente"]);

function errorCorto(salida: unknown): string | null {
  if (salida === null || salida === undefined) return "sin_respuesta";
  if (typeof salida !== "object" || Array.isArray(salida)) return null;
  const o = salida as Record<string, unknown>;
  if (typeof o["error"] === "string" && o["error"] !== "") return o["error"].slice(0, 60);
  if (o["error"] !== undefined && o["error"] !== null && o["error"] !== false) return "error";
  if (o["ok"] === false) return "ok_false";
  return null;
}

export class TrazaHerramientas {
  readonly registros: RegistroHerramienta[] = [];
  private turno = 0;
  private textoTurno = "";
  private cotizoEnTurno = false;
  private confirmadoVigente = false;

  constructor(private readonly regla: ReglaPedidos = REGLA_PEDIDOS_PM) {}

  alTurnoCliente(texto: string): void {
    this.turno += 1;
    this.textoTurno = texto;
    this.cotizoEnTurno = false;
  }

  get intentosCrearSinConfirmar(): number {
    return this.registros.filter((r) => r.nombre === this.regla.crear && r.sinConfirmar === true).length;
  }

  /** Crear que llego a ejecutarse con exito sin confirmacion vigente: pedido indebido (P0). */
  get crearIndebidosEjecutados(): number {
    return this.registros.filter((r) => r.nombre === this.regla.crear && r.sinConfirmar === true && r.ok).length;
  }

  decorar(ejecutar: EjecutarTool): EjecutarTool {
    return async (llamada: ToolCallPedida, ctx) => {
      const esCrear = llamada.nombre === this.regla.crear;
      const sinConfirmar = esCrear ? !this.confirmadoVigente || this.cotizoEnTurno || !esAfirmacion(this.textoTurno) : undefined;
      const orden = this.registros.length;
      let salida: unknown;
      try {
        salida = await ejecutar(llamada, ctx ?? { turno: this.turno });
      } catch {
        salida = { error: "herramienta_fallo" };
      }
      const error = errorCorto(salida);
      const ok = error === null;
      this.registros.push({
        nombre: llamada.nombre, turnoCliente: this.turno, orden, ok, error, bloqueadaPorCompuerta: error !== null && BLOQUEOS.has(error),
        ...(sinConfirmar === undefined ? {} : { sinConfirmar }),
      });
      if (ok) {
        if (llamada.nombre === this.regla.cotizar) { this.cotizoEnTurno = true; this.confirmadoVigente = false; }
        if (llamada.nombre === this.regla.confirmar) this.confirmadoVigente = true;
        if (esCrear) this.confirmadoVigente = false;
      }
      return salida;
    };
  }
}
