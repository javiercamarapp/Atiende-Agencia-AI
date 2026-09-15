-- Hallazgo de auditoría (severidad ALTA): 009_company_capabilities_experience_signers.sql
-- creó licitaciones.company_capability/company_experience/company_signer con RLS y
-- policies completas (select/insert/update vía can_access_org/can_write_org), pero --
-- a diferencia de TODAS las demás migraciones de este paquete que crean tablas nuevas
-- (001/003/004/005/006/007/008/010/011/012/013/014/015/016/017/019, ver el
-- "revoke all ... from public, anon; grant select/insert/update ... to authenticated;
-- grant ... to service_role;" que cada una trae) -- nunca agregó el GRANT
-- correspondiente para el rol "authenticated". RLS por sí sola no basta: sin un GRANT
-- explícito, Postgres responde "permission denied for table company_capability/
-- company_experience/company_signer" ANTES de siquiera evaluar las policies, para
-- cualquier SELECT/INSERT/UPDATE que un usuario "authenticated" real intente sobre
-- esas 3 tablas -- rompiendo en silencio la propuesta técnica (technical-proposal.ts)
-- para cualquier requisito mapeado a capacidad/experiencia/firmante en producción,
-- aunque el repositorio en memoria (que no tiene GRANTs de Postgres) nunca lo detecta.
--
-- Mismo patrón EXACTO que las 3 tablas existentes (approval_status con policies de
-- insert/update, sin policy de delete -- por eso ningún GRANT de "delete" a
-- "authenticated" tampoco aquí, igual que 004/007/008/011/013/014/016/017).
--
-- Requiere: 009 (crea las 3 tablas + sus policies) ya aplicada.

revoke all on licitaciones.company_capability, licitaciones.company_experience, licitaciones.company_signer from public, anon;
grant select, insert, update on licitaciones.company_capability, licitaciones.company_experience, licitaciones.company_signer to authenticated;
grant select, insert, update, delete on licitaciones.company_capability, licitaciones.company_experience, licitaciones.company_signer to service_role;
