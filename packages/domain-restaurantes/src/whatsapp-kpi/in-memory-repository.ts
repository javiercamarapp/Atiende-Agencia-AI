// Repositorio en memoria del KPI de WhatsApp para pruebas de API: reproduce el contrato de "no disponible" y el relleno de
// dias en cero, NO RLS ni las definiciones SQL (eso lo prueba scripts/verify-restaurantes-whatsapp-kpi/ contra Postgres real).
import type { WhatsappEntregaDia, WhatsappKpiDia, WhatsappKpiLectura, WhatsappKpiRepository } from "./kpi.ts";

export class InMemoryWhatsappKpiRepository implements WhatsappKpiRepository {
  /** false simula la base sin migrar. */
  disponible = true;
  readonly dias = new Map<string, WhatsappKpiDia[]>();
  /** false simula la base sin la migracion 066 (solo para `getEntregaDiaria`). */
  entregaDisponible = true;
  readonly entrega = new Map<string, WhatsappEntregaDia[]>();
  readonly consultas: { organizationId: string; propertyId: string; desde: string; hasta: string }[] = [];

  async getKpisDiarios(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<WhatsappKpiLectura<readonly WhatsappKpiDia[]>> {
    this.consultas.push({ organizationId, propertyId, desde, hasta });
    if (!this.disponible) return { disponible: false, valor: [] };
    const guardados = this.dias.get(`${organizationId}:${propertyId}`) ?? [];
    const out: WhatsappKpiDia[] = [];
    for (let f = desde; f <= hasta; f = siguienteDiaWhatsapp(f)) out.push(guardados.find((d) => d.fecha === f) ?? whatsappDiaVacio(f));
    return { disponible: true, valor: out };
  }

  async getEntregaDiaria(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<WhatsappKpiLectura<readonly WhatsappEntregaDia[]>> {
    if (!this.entregaDisponible) return { disponible: false, valor: [] };
    const guardados = this.entrega.get(`${organizationId}:${propertyId}`) ?? [];
    const out: WhatsappEntregaDia[] = [];
    for (let f = desde; f <= hasta; f = siguienteDiaWhatsapp(f)) out.push(guardados.find((d) => d.fecha === f) ?? whatsappEntregaDiaVacia(f));
    return { disponible: true, valor: out };
  }
}

export function whatsappEntregaDiaVacia(fecha: string): WhatsappEntregaDia {
  return { fecha, enviados: 0, entregados: 0, leidos: 0, fallidos: 0, sinEstado: 0, fallosPorMotivo: {} };
}

export function siguienteDiaWhatsapp(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function whatsappDiaVacio(fecha: string, zonaHoraria = "America/Mexico_City"): WhatsappKpiDia {
  return {
    fecha, zonaHoraria, conversaciones: 0, conversacionesConPedido: 0, conversacionesConHandoff: 0, pedidos: 0, handoffs: 0,
    pedidosOrg: 0, orgEsDemo: false, costoLlmOrgMicroUsd: 0, costoLlmOrgCentavosMxn: 0,
  };
}
