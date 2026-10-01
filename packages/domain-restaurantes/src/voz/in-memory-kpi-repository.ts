// Repositorio en memoria de KPI de voz para pruebas de API y de dominio. Reproduce la REGLA de negocio (misma
// evaluacion de umbrales, mismo contrato de "no disponible"), NO RLS/GRANT: eso lo prueba
// scripts/verify-restaurantes-voz-kpi/ contra Postgres real.
import type { VozKpiRepository } from "./kpi-repository.ts";
import { VOZ_UMBRALES_POR_DEFECTO, evaluarAlertasDia } from "./kpi.ts";
import type { VozAlerta, VozKpiDia, VozUmbrales, VozUmbralesEntrada } from "./kpi.ts";
import { VozNoDisponibleError } from "./types.ts";
import type { VozLectura } from "./types.ts";

export class InMemoryVozKpiRepository implements VozKpiRepository {
  /** false simula la base sin migrar. */
  disponible = true;
  readonly dias = new Map<string, VozKpiDia[]>();
  readonly umbrales = new Map<string, VozUmbrales>();
  readonly alertas = new Map<string, VozAlerta[]>();
  /** Dia local "hoy" para evaluar alertas (los tests lo fijan). */
  hoy = "2026-03-10";

  private clave(org: string, prop: string): string {
    return `${org}:${prop}`;
  }

  async getKpisDiarios(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<VozLectura<readonly VozKpiDia[]>> {
    if (!this.disponible) return { disponible: false, valor: [] };
    const guardados = this.dias.get(this.clave(organizationId, propertyId)) ?? [];
    const out: VozKpiDia[] = [];
    for (let f = desde; f <= hasta; f = siguienteDia(f)) {
      out.push(guardados.find((d) => d.fecha === f) ?? diaVacio(f));
    }
    return { disponible: true, valor: out };
  }

  async getUmbrales(propertyId: string): Promise<VozLectura<VozUmbrales>> {
    if (!this.disponible) return { disponible: false, valor: VOZ_UMBRALES_POR_DEFECTO };
    return { disponible: true, valor: this.umbrales.get(propertyId) ?? VOZ_UMBRALES_POR_DEFECTO };
  }

  async upsertUmbrales(_organizationId: string, propertyId: string, _actorUserId: string, entrada: VozUmbralesEntrada): Promise<VozUmbrales> {
    if (!this.disponible) throw new VozNoDisponibleError();
    const guardado: VozUmbrales = { configurado: true, ...entrada };
    this.umbrales.set(propertyId, guardado);
    return guardado;
  }

  async evaluarAlertas(organizationId: string, propertyId: string): Promise<VozLectura<readonly VozAlerta[]>> {
    if (!this.disponible) return { disponible: false, valor: [] };
    const cfg = this.umbrales.get(propertyId);
    if (!cfg) return { disponible: true, valor: [] };
    const dia = (this.dias.get(this.clave(organizationId, propertyId)) ?? []).find((d) => d.fecha === this.hoy) ?? diaVacio(this.hoy);
    const previas = this.alertas.get(this.clave(organizationId, propertyId)) ?? [];
    const nuevas = new Set<string>();
    for (const a of evaluarAlertasDia(cfg, dia)) {
      if (!previas.some((p) => p.fecha === this.hoy && p.tipo === a.tipo)) {
        previas.push({ ...a, nueva: false });
        nuevas.add(a.tipo);
      }
    }
    this.alertas.set(this.clave(organizationId, propertyId), previas);
    return { disponible: true, valor: previas.filter((a) => a.fecha === this.hoy).map((a) => ({ ...a, nueva: nuevas.has(a.tipo) })) };
  }

  async listAlertas(organizationId: string, propertyId: string, limite: number): Promise<VozLectura<readonly VozAlerta[]>> {
    if (!this.disponible) return { disponible: false, valor: [] };
    const todas = [...(this.alertas.get(this.clave(organizationId, propertyId)) ?? [])].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
    return { disponible: true, valor: todas.slice(0, limite) };
  }
}

export function siguienteDia(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function diaVacio(fecha: string, zonaHoraria = "America/Mexico_City"): VozKpiDia {
  return {
    fecha, zonaHoraria, llamadas: 0, llamadasCerradas: 0, duracionTotalS: 0, pedidosVoz: 0, escaladas: 0, abandonadas: 0,
    erroresProveedor: 0, erroresElevenlabs: 0, erroresTwilio: 0, erroresOtros: 0, toolCalls: 0, toolP95Ms: null,
    costoVozMicroUsd: 0, costoTelefoniaMicroUsd: 0, costoTotalCentavosMxn: 0, costoLlmOrgMicroUsd: null, costoLlmOrgCentavosMxn: null,
  };
}
