-- SOLO en la copia efimera del arnes (Postgres local, nunca la base real): enciende el cerebro v2 de la organizacion de PM y da a cada sucursal un
-- secreto de voz de PRUEBA (`qa-voz-turno-<slug>`, solo se guarda su sha256) para POST /v1/restaurantes/voz/turno. Requiere las migraciones 026/190/191.
insert into restaurantes.agent_runtime_settings (organization_id, cerebro_v2) values ('f838fd2c-967e-46fd-af8d-e0229b15748d', true)
  on conflict (organization_id) do update set cerebro_v2 = true;
insert into restaurantes.voice_branch_secret (property_id, organization_id, secret_hash, secret_hint)
  select b.property_id, b.organization_id, encode(sha256(convert_to('qa-voz-turno-' || b.slug, 'UTF8')), 'hex'), 'qa'
    from restaurantes.branch_detail b
   where b.organization_id = 'f838fd2c-967e-46fd-af8d-e0229b15748d'
  on conflict (property_id) do update set secret_hash = excluded.secret_hash, secret_hint = excluded.secret_hint, previous_hash = null, previous_valid_until = null;
