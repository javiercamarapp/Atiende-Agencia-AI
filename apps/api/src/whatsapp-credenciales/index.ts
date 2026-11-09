// Credenciales de Meta (WhatsApp Cloud API) por organizacion: varias apps de Meta a la vez (migracion 0090). Ver
// docs/WHATSAPP-CREDENCIALES-POR-ORGANIZACION.md.
export {
  aadCredencialMeta,
  CredencialesMetaLlaveInvalidaError,
  CredencialMetaDescifradoError,
  crearCifradorCredencialesMeta,
  parsearLlaveCredencialesMeta,
} from "./cifrado.ts";
export type { CampoCredencialMeta, CifradorCredencialesMeta } from "./cifrado.ts";
export { hashVerifyToken, verificarFirmaConCandidatos, verifyTokenEnHashes } from "./firma.ts";
export type { CandidatoFirma } from "./firma.ts";
export { autorizarWebhookMeta, crearResolutorCredencialesMeta, numeroAutorizado } from "./resolutor.ts";
export type {
  AutorizacionWebhookMeta,
  CredencialMeta,
  FilaCredencialSistema,
  OpcionesResolutorCredencialesMeta,
  ResolutorCredencialesMeta,
  ResultadoAutorizacionWebhook,
} from "./resolutor.ts";
export {
  asignarNumero,
  esCredencialesMetaNoMigrada,
  leerCredencialesParaSistema,
  listarParaSuperadmin,
  registrarCredencial,
  revocarCredencial,
  rotarCredencial,
} from "./repositorio.ts";
export type { CredencialMetaResumen, LecturaSuperadmin, NumeroMetaResumen, ResultadoEscritura } from "./repositorio.ts";

import type { CifradorCredencialesMeta } from "./cifrado.ts";
import type { ResolutorCredencialesMeta } from "./resolutor.ts";

/** Lo que la API necesita para credenciales por organizacion. Ausente (sin WHATSAPP_CREDENTIALS_KEY) = comportamiento anterior. */
export interface WhatsAppMetaDeps {
  readonly cifrador: CifradorCredencialesMeta;
  readonly resolutor: ResolutorCredencialesMeta;
}
