// Bandera de diseno POR ORGANIZACION (migracion 0060). La sesion trae `organizations[].diseno`; este hook lo guarda para que
// /theme-boot.js pinte el diseno correcto desde el primer cuadro en la proxima carga y, si lo pintado ya no coincide, recarga UNA
// vez: las ramas JS de DISENO_DS3 se leen al cargar el modulo, asi que una recarga es la unica forma honesta de cambiarlas todas.
// Lo llama `useVerticalSession`, que usan los 6 shells de vertical (restaurantes, citas, hoteles, despachos, licitaciones, rentas).
import { useEffect } from "react";
import { disenoPorDefecto, sincronizarDisenoOrganizacion } from "@atiende/ui";
import type { LoginSession } from "./auth-client.ts";

/** Guarda de una sola recarga por pestana y por valor: si tras recargar algo impide aplicar el diseno, no hay bucle. */
export const CLAVE_RECARGA_DISENO = "atiende-diseno-recarga";

export function recargarPorDiseno(diseno: string | null, recargar: () => void = () => window.location.reload()): boolean {
  const marca = `${diseno ?? "actual"}`;
  try {
    if (window.sessionStorage.getItem(CLAVE_RECARGA_DISENO) === marca) return false;
    window.sessionStorage.setItem(CLAVE_RECARGA_DISENO, marca);
  } catch {
    return false;
  }
  recargar();
  return true;
}

export function useDisenoOrganizacion(session: LoginSession | null | undefined, orgSlug: string): void {
  useEffect(() => {
    if (!session) return;
    const org = session.organizations.find((o) => o.slug === orgSlug);
    if (!org || org.diseno === undefined) return;
    if (sincronizarDisenoOrganizacion(org.diseno, disenoPorDefecto())) recargarPorDiseno(org.diseno ?? null);
  }, [session, orgSlug]);
}
