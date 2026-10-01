// Utilidades compartidas por las rutas de privacidad (H-02) y la captura de identidad con consentimiento.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { PostgresPrivacyRepository, type ConsentRecord, type PrivacyRepository } from "@atiende/domain-hoteles";
import type { AppDeps } from "../../../deps.ts";

export function privacyRepo(deps: AppDeps, c: Context<CoreAuthHonoEnv>): PrivacyRepository {
  const db = c.get("db");
  return deps.hotelesPrivacidadRepo ? deps.hotelesPrivacidadRepo(db) : new PostgresPrivacyRepository(db);
}

export function serializeConsent(r: ConsentRecord) {
  return {
    id: r.id, huespedId: r.guestId, identidadId: r.vaultId, avisoId: r.noticeId, versionAviso: r.noticeVersion, finalidadesObligatorias: r.acceptedMandatory,
    finalidadesOpcionales: r.acceptedOptional, canal: r.channel, metodo: r.evidenceMethod, datosSensibles: r.sensitiveData, consentidoEn: r.consentedAt,
    capturadoPor: r.capturedBy, revocadoEn: r.revokedAt, revocadoPor: r.revokedBy, motivoRevocacion: r.revokeReason,
  };
}
