// f2-citas-whatsapp-config-sesion-sistema — doble de prueba que hace visible,
// contra `InMemoryCitasRepository` (que normalmente no distingue sesión de
// staff/sistema — ver el comentario de `resolveActiveWhatsAppPhoneNumberIdAsSystem`
// en `../../src/in-memory-repository.ts`), CUÁL variante de
// `resolveActiveWhatsAppPhoneNumberId*` llama de verdad cada caller:
// `resolveActiveWhatsAppPhoneNumberId` (STAFF) lanza si se invoca -- un caller
// que corre en sesión de SISTEMA (`runConfirmacionCitaCore`,
// `crisis-guardrail.ts::notifyOwnerOfEscalation`) NUNCA debería llamarlo --
// mientras que `resolveActiveWhatsAppPhoneNumberIdAsSystem` sigue resolviendo el
// dato real (vía `super.resolveActiveWhatsAppPhoneNumberId`, la implementación
// original de la base, nunca el override que lanza). Sin este doble, un test
// contra `InMemoryCitasRepository` a secas pasaría igual sin importar cuál de
// las dos variantes llame el código de producción (ambas devuelven el mismo
// dato en memoria) -- exactamente por qué el bug real (gap de RLS de
// `citas.whatsapp_config` bajo sesión de sistema, solo visible contra Postgres
// real) sobrevivió sin que ningún test en memoria lo viera.
import { InMemoryCitasRepository } from "../../src/in-memory-repository.ts";

export class ThrowsOnStaffWhatsAppRepo extends InMemoryCitasRepository {
  async resolveActiveWhatsAppPhoneNumberId(organizationId: string): Promise<string | null> {
    void organizationId;
    throw new Error(
      "BLOQUEANTE (test): resolveActiveWhatsAppPhoneNumberId (variante de STAFF, RLS de membership) fue llamado desde lo que en producción es SIEMPRE una sesión de SISTEMA -- ver f2-citas-whatsapp-config-sesion-sistema. Contra Postgres real, `auth.uid()` null hace que esta consulta devuelva 0 filas en silencio; en esta prueba lanza a propósito para que el defecto sea visible sin necesitar Postgres real.",
    );
  }

  async resolveActiveWhatsAppPhoneNumberIdAsSystem(organizationId: string): Promise<string | null> {
    // Llama la implementación ORIGINAL de la base (nunca el override de arriba
    // que lanza) -- simula la RPC de sistema real
    // (`citas.system_resolve_active_whatsapp_phone_number_id`, migración 021),
    // que sí resuelve el mismo dato bajo sesión de sistema.
    return super.resolveActiveWhatsAppPhoneNumberId(organizationId);
  }
}
