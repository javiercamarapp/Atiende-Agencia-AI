-- ROLLBACK MANUAL de packages/db/migrations/0076_copiloto_valoraciones.sql (espejo supabase 20240101000630).
-- Se corre a mano (psql con el rol de migraciones), nunca en CI ni al fusionar. Ver docs/ROLLBACK.md: un rollback de codigo no revierte la base;
-- esto si. Se pierden las valoraciones guardadas (solo «Útil / No fue útil» y su motivo; nada mas depende de ellas). El codigo de la API ya
-- degrada solo sin la tabla ni las funciones (503 honesto en el PUT, `disponible: false` en los resumenes), asi que el orden con el codigo da igual.
begin;

drop function if exists core.superadmin_data_chat_feedback_resumen(uuid, timestamptz);
drop function if exists core.data_chat_feedback_resumen(uuid, timestamptz);
drop table if exists core.data_chat_feedback;

commit;
