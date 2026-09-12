// registrar_contacto_no_operativo (voz + WhatsApp, diseño Fase 2 §2.3) — port del
// mismo rol que registerCallbackRequest de domain-restaurantes: cierra el hueco de
// "cualquier mensaje que no sea una petición operativa de F&B" derivándolo a un
// humano, en vez de dejarlo sin registro.
import type { HotelesRepository } from "./repository.ts";
import type { ContactoNoOperativoRecord, NewContactoNoOperativoInput } from "./types.ts";

export async function registerContactoNoOperativo(repo: HotelesRepository, input: NewContactoNoOperativoInput): Promise<ContactoNoOperativoRecord> {
  if (!input.reason.trim()) {
    throw new Error("reason es requerido para registrar un contacto no operativo");
  }
  return repo.insertContactoNoOperativo(input);
}
