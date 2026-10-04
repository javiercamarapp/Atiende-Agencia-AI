// Repositorio en memoria del perfil del repartidor para pruebas y la API simulada de e2e. Reproduce las reglas de acceso de la base
// (propio repartidor u owner/admin; staff de piso sin acceso) para que las pruebas de ruta no dependan de SQL; las reglas reales de
// RLS las prueba scripts/verify-restaurantes-repartidor-perfil.
import type { GuardarPerfilResultado, LicenciaPorVencer, PerfilLectura, RepartidorPerfil, RepartidorPerfilEntrada, RepartidorPerfilRepository } from "./perfil.ts";

export class InMemoryRepartidorPerfilRepository implements RepartidorPerfilRepository {
  readonly filas = new Map<string, RepartidorPerfil>();
  constructor(private readonly opciones: { readonly disponible?: boolean; readonly licencias?: readonly LicenciaPorVencer[]; readonly noRepartidores?: ReadonlySet<string> } = {}) {}

  private k(org: string, user: string): string {
    return `${org}|${user}`;
  }

  async obtener(organizationId: string, userId: string): Promise<PerfilLectura> {
    if (this.opciones.disponible === false) return { disponible: false, perfil: null };
    return { disponible: true, perfil: this.filas.get(this.k(organizationId, userId)) ?? null };
  }

  async guardar(organizationId: string, userId: string, e: RepartidorPerfilEntrada): Promise<GuardarPerfilResultado> {
    if (this.opciones.disponible === false) return { estado: "no_disponible" };
    if (this.opciones.noRepartidores?.has(userId)) return { estado: "no_es_repartidor" };
    this.filas.set(this.k(organizationId, userId), { ...e, userId, updatedAt: new Date(0).toISOString() });
    return { estado: "ok" };
  }

  async suprimir(organizationId: string, userId: string): Promise<{ readonly disponible: boolean; readonly borrado: boolean; readonly prohibido: boolean }> {
    if (this.opciones.disponible === false) return { disponible: false, borrado: false, prohibido: false };
    return { disponible: true, borrado: this.filas.delete(this.k(organizationId, userId)), prohibido: false };
  }

  async licenciasPorVencer(_dias: number): Promise<{ readonly disponible: boolean; readonly valor: readonly LicenciaPorVencer[] }> {
    if (this.opciones.disponible === false) return { disponible: false, valor: [] };
    return { disponible: true, valor: this.opciones.licencias ?? [] };
  }
}
