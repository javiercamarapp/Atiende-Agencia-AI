// Puerto de persistencia de la ficha de huesped (H-27). Separado de `HotelesRepository` (mismo criterio que housekeeping y
// la boveda) para no ensanchar el puerto grande. Las lecturas que dependen de migraciones posteriores a la base minima
// degradan a `null` ("no disponible") en vez de afirmar "vacio": nunca se confunde "sin datos" con "no se pudo saber".
import type { GuestConsentRow, GuestContactRequestRow, GuestNoteKind, GuestNoteRecord, GuestNotesResult, GuestStayRow } from "./tipos.ts";

export interface HuespedesRepository {
  /** Historial de estancias del huesped (mas recientes primero, acotado). */
  listarEstancias(propertyId: string, guestId: string, limit: number): Promise<readonly GuestStayRow[]>;
  /** Solicitudes de contacto no operativas (voz/WhatsApp) cuyo telefono coincide (ultimos 10 digitos) con el del huesped. */
  listarContactos(propertyId: string, phoneKey: string | null, limit: number): Promise<readonly GuestContactRequestRow[]>;
  /** Consentimientos de privacidad del huesped; `null` si la base aun no tiene la migracion 032. */
  listarConsentimientos(propertyId: string, guestId: string): Promise<readonly GuestConsentRow[] | null>;
  /** Hay una identidad activa en la boveda; `null` si la base aun no tiene la migracion 031. */
  tieneIdentidadActiva(propertyId: string, guestId: string): Promise<boolean | null>;
  /** El huesped tiene una solicitud ARCO de cancelacion/oposicion no improcedente; `null` sin la migracion 038. */
  tieneRestriccionArco(guestId: string): Promise<boolean | null>;
  /** Notas y preferencias activas. */
  listarNotas(propertyId: string, guestId: string): Promise<GuestNotesResult>;
  /** Agrega una nota. Lanza los errores de dominio `Huespedes*` (nunca un 500 crudo). */
  agregarNota(input: { readonly propertyId: string; readonly guestId: string; readonly kind: GuestNoteKind; readonly body: string }): Promise<GuestNoteRecord>;
  /** Archiva una nota activa. `null` si no existe o ya estaba archivada. */
  archivarNota(propertyId: string, guestId: string, noteId: string): Promise<GuestNoteRecord | null>;
}
