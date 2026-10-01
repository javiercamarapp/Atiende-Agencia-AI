-- D-08 (portal del cliente final) -- verificación contra Postgres REAL de la migración 016.
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en
-- ERROR; alias `..._deberia_ser_N` = el valor esperado (ver run-gate.mjs). Los hashes de token son
-- cadenas ficticias repetidas (no hay secretos): '1'x64 = enlace vigente de A, '2'x64 = vigente de B,
-- '3'x64 = expirado de A, '4'x64 = revocado de A.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-000000d08a01', 'despachos', 'Despacho A', 'despacho-a-portal'),
  ('00000000-0000-0000-0000-000000d08a02', 'despachos', 'Despacho B', 'despacho-b-portal'),
  ('00000000-0000-0000-0000-000000d08a03', 'hoteles', 'Hotel H', 'hotel-h-portal')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08a01', 'despachos', 'Cliente A'),
  ('00000000-0000-0000-0000-000000d08b02', '00000000-0000-0000-0000-000000d08a02', 'despachos', 'Cliente B'),
  ('00000000-0000-0000-0000-000000d08b03', '00000000-0000-0000-0000-000000d08a03', 'hoteles', 'Hotel H1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000d08c01', 'portal-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-000000d08c02', 'portal-b@example.com', 'Staff B', 'seed'),
  ('00000000-0000-0000-0000-000000d08c03', 'portal-h@example.com', 'Staff hoteles', 'seed'),
  ('00000000-0000-0000-0000-000000d08c04', 'portal-none@example.com', 'Sin membresia', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000d08c01', '00000000-0000-0000-0000-000000d08a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d08c02', '00000000-0000-0000-0000-000000d08a02', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d08c03', '00000000-0000-0000-0000-000000d08a03', null, 'admin', 'admin')
on conflict do nothing;
insert into despachos.tenant_profile (organization_id, rfc, razon_social) values
  ('00000000-0000-0000-0000-000000d08a01', 'DAA010101AA1', 'Despacho Contable A SC')
on conflict do nothing;
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha) values
  ('00000000-0000-0000-0000-000000d08d01', '00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08d11', 'I', 'AAA010101AA1', 'RRR010101RR1', 100, 116, true, '2026-07-10'),
  ('00000000-0000-0000-0000-000000d08d02', '00000000-0000-0000-0000-000000d08a02', '00000000-0000-0000-0000-000000d08b02', '00000000-0000-0000-0000-000000d08d12', 'I', 'AAA010101AA1', 'RRR020202RR2', 200, 232, true, '2026-07-11')
on conflict do nothing;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', 'ISR', '2026-07', '2026-08-17', 'alta'),
  ('00000000-0000-0000-0000-000000d08a02', '00000000-0000-0000-0000-000000d08b02', 'IVA', '2026-07', '2026-08-17', 'alta')
on conflict do nothing;
insert into despachos.periodo_cierre (id, organization_id, property_id, anio, mes) values
  ('00000000-0000-0000-0000-000000d08ca1', '00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', 2026, 6),
  ('00000000-0000-0000-0000-000000d08ca2', '00000000-0000-0000-0000-000000d08a02', '00000000-0000-0000-0000-000000d08b02', 2026, 6)
on conflict do nothing;
insert into despachos.portal_cliente_enlace (id, organization_id, property_id, token_hash, etiqueta, creado_por, creado_en, expira_en, revocado_en) values
  ('00000000-0000-0000-0000-000000d08e01', '00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', repeat('1', 64), 'Contacto A', '00000000-0000-0000-0000-000000d08c01', now() - interval '1 day', now() + interval '60 days', null),
  ('00000000-0000-0000-0000-000000d08e02', '00000000-0000-0000-0000-000000d08a02', '00000000-0000-0000-0000-000000d08b02', repeat('2', 64), 'Contacto B', '00000000-0000-0000-0000-000000d08c02', now() - interval '1 day', now() + interval '60 days', null),
  ('00000000-0000-0000-0000-000000d08e03', '00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', repeat('3', 64), 'Expirado A', '00000000-0000-0000-0000-000000d08c01', now() - interval '10 days', now() - interval '1 day', null),
  ('00000000-0000-0000-0000-000000d08e04', '00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', repeat('4', 64), 'Revocado A', '00000000-0000-0000-0000-000000d08c01', now() - interval '10 days', now() + interval '30 days', now() - interval '1 hour')
on conflict do nothing;
insert into despachos.portal_cliente_documento (id, organization_id, property_id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, sha256, contenido) values
  ('00000000-0000-0000-0000-000000d08f01', '00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08e01', 'pdf', 'constancia-A.pdf', 'application/pdf', 6, encode(sha256('%PDF-A'::bytea), 'hex'), '%PDF-A'::bytea),
  ('00000000-0000-0000-0000-000000d08f02', '00000000-0000-0000-0000-000000d08a02', '00000000-0000-0000-0000-000000d08b02', '00000000-0000-0000-0000-000000d08e02', 'pdf', 'constancia-B.pdf', 'application/pdf', 6, encode(sha256('%PDF-B'::bytea), 'hex'), '%PDF-B'::bytea)
on conflict do nothing;
insert into despachos.portal_cliente_mensaje (organization_id, property_id, autor, cuerpo) values
  ('00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', 'cliente', 'mensaje-del-cliente-A'),
  ('00000000-0000-0000-0000-000000d08a02', '00000000-0000-0000-0000-000000d08b02', 'cliente', 'mensaje-del-cliente-B')
on conflict do nothing;

\echo '=== RESUMEN DEL CLIENTE (acceso por token, solo sistema) ==='

\echo '1. token vigente de A -> ve el nombre de SU cliente y su despacho'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (r->'cliente'->>'nombre' = 'Cliente A' and r->'despacho'->>'nombre' = 'Despacho Contable A SC')::int as resumen_propio_deberia_ser_1
from (select despachos.portal_cliente_resumen(repeat('1', 64)) as r) x;
rollback;

\echo '2. aislamiento cross-cliente (A): solo su obligacion, su cierre, su documento y su mensaje'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (
  jsonb_array_length(r->'obligaciones') = 1 and r->'obligaciones'->0->>'tipo' = 'ISR'
  and jsonb_array_length(r->'cierres') = 1 and (r->'cierres'->0->>'mes')::int = 6
  and jsonb_array_length(r->'documentos') = 1 and r->'documentos'->0->>'nombre_archivo' = 'constancia-A.pdf'
  and jsonb_array_length(r->'mensajes') = 1 and r->'mensajes'->0->>'cuerpo' = 'mensaje-del-cliente-A'
)::int as aislamiento_a_deberia_ser_1
from (select despachos.portal_cliente_resumen(repeat('1', 64)) as r) x;
rollback;

\echo '3. aislamiento cross-cliente / cross-tenant (B): solo lo suyo, nada de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (
  r->'cliente'->>'nombre' = 'Cliente B'
  and jsonb_array_length(r->'obligaciones') = 1 and r->'obligaciones'->0->>'tipo' = 'IVA'
  and jsonb_array_length(r->'documentos') = 1 and r->'documentos'->0->>'nombre_archivo' = 'constancia-B.pdf'
  and jsonb_array_length(r->'mensajes') = 1 and r->'mensajes'->0->>'cuerpo' = 'mensaje-del-cliente-B'
  and position('Cliente A' in r::text) = 0 and position('mensaje-del-cliente-A' in r::text) = 0
)::int as aislamiento_b_deberia_ser_1
from (select despachos.portal_cliente_resumen(repeat('2', 64)) as r) x;
rollback;

\echo '4. el resumen NO expone token_hash, ids de property/organizacion ni contenido de archivos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (
  position('token_hash' in r::text) = 0 and position('property_id' in r::text) = 0
  and position('organization_id' in r::text) = 0 and position('contenido' in r::text) = 0
  and position(repeat('1', 64) in r::text) = 0
)::int as sin_fuga_de_campos_deberia_ser_1
from (select despachos.portal_cliente_resumen(repeat('1', 64)) as r) x;
rollback;

\echo '5. token expirado -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_resumen(repeat('3', 64)) as should_fail;
rollback;

\echo '6. token revocado -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_resumen(repeat('4', 64)) as should_fail;
rollback;

\echo '7. token inexistente -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_resumen(repeat('9', 64)) as should_fail;
rollback;

\echo '8. hash mal formado / nulo -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_resumen('no-es-un-hash') as should_fail;
rollback;

\echo '9. sin enumeracion: expirado, revocado e inexistente fallan con el MISMO SQLSTATE y mensaje'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  a text; b text; c text;
begin
  begin perform despachos.portal_cliente_resumen(repeat('3', 64)); exception when others then a := sqlstate || sqlerrm; end;
  begin perform despachos.portal_cliente_resumen(repeat('4', 64)); exception when others then b := sqlstate || sqlerrm; end;
  begin perform despachos.portal_cliente_resumen(repeat('9', 64)); exception when others then c := sqlstate || sqlerrm; end;
  if a is null or a is distinct from b or b is distinct from c then
    raise exception 'oraculo de estado de enlace: % / % / %', a, b, c;
  end if;
end $$;
rollback;

\echo '10. un staff con sub real NO puede usar las funciones del portal del cliente (aunque tenga el hash)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_cliente_resumen(repeat('1', 64)) as should_fail;
rollback;

\echo '11. anon NO tiene EXECUTE sobre el resumen'
begin;
set local role anon;
select despachos.portal_cliente_resumen(repeat('1', 64)) as should_fail;
rollback;

\echo '12. revocacion efectiva: el staff revoca y el MISMO token deja de funcionar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_enlace_revocar('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08e01');
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_resumen(repeat('1', 64)) as should_fail;
rollback;

\echo '13. el contador de accesos se actualiza (ultimo_uso_en) al abrir el portal'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_resumen(repeat('1', 64));
reset role;
select (ultimo_uso_en is not null and usos = 1)::int as uso_registrado_deberia_ser_1 from despachos.portal_cliente_enlace where id = '00000000-0000-0000-0000-000000d08e01';
rollback;

\echo '=== DOCUMENTOS (subida del cliente) ==='

\echo '14. PDF valido -> recibido, no duplicado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'recibido' and not out_duplicado)::int as pdf_recibido_deberia_ser_1
from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'acuse.pdf', 'application/pdf', '%PDF-1.4 contenido'::bytea, '{}'::jsonb);
rollback;

\echo '15. replay: el mismo archivo dos veces NO duplica la fila'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'acuse.pdf', 'application/pdf', '%PDF-1.4 replay'::bytea, '{}'::jsonb);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'otro-nombre.pdf', 'application/pdf', '%PDF-1.4 replay'::bytea, '{}'::jsonb);
reset role;
select (count(*) = 1)::int as una_sola_fila_deberia_ser_1 from despachos.portal_cliente_documento where property_id = '00000000-0000-0000-0000-000000d08b01' and nombre_archivo in ('acuse.pdf', 'otro-nombre.pdf');
rollback;

\echo '16. el mismo archivo en dos properties distintas produce dos filas (sin dedupe cross-tenant)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'igual.pdf', 'application/pdf', '%PDF-1.4 igual'::bytea, '{}'::jsonb);
select * from despachos.portal_cliente_documento_recibir(repeat('2', 64), 'pdf', 'igual.pdf', 'application/pdf', '%PDF-1.4 igual'::bytea, '{}'::jsonb);
reset role;
select (count(distinct property_id) = 2 and count(*) = 2)::int as dos_properties_deberia_ser_1 from despachos.portal_cliente_documento where nombre_archivo = 'igual.pdf';
rollback;

\echo '17. el documento queda en la property del TOKEN (el cliente no elige property)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('2', 64), 'pdf', 'de-b.pdf', 'application/pdf', '%PDF-1.4 de b'::bytea, '{}'::jsonb);
reset role;
select (property_id = '00000000-0000-0000-0000-000000d08b02' and organization_id = '00000000-0000-0000-0000-000000d08a02')::int as property_del_token_deberia_ser_1
from despachos.portal_cliente_documento where nombre_archivo = 'de-b.pdf';
rollback;

\echo '18. XML CFDI sin DTD -> recibido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_estado = 'recibido')::int as xml_ok_deberia_ser_1
from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'cfdi_xml', 'factura.xml', 'application/xml', '<?xml version="1.0"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0"/>'::bytea, '{"total": "116.00"}'::jsonb);
rollback;

\echo '19. XML con DOCTYPE (XXE) -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'cfdi_xml', 'xxe.xml', 'application/xml', '<?xml version="1.0"?><!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '20. XML con entidades internas (billion laughs) -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'cfdi_xml', 'ent.xml', 'application/xml', '<?xml version="1.0"?><!ENTITY x "y"><a>&x;</a>'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '21. archivo "pdf" con firma falsa -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'falso.pdf', 'application/pdf', '<script>alert(1)</script>'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '22. archivo "imagen" con firma falsa -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'imagen', 'falso.png', 'image/png', 'GIF89a-no-es-png'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '23. mas de 2 MiB -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'cfdi_xml', 'grande.xml', 'application/xml', convert_to('<a>' || repeat('x', 2097200) || '</a>', 'UTF8'), '{}'::jsonb) as should_fail;
rollback;

\echo '24. archivo vacio -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'cfdi_xml', 'vacio.xml', 'application/xml', ''::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '25. tipo/mime incoherentes (pdf con text/xml) -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'raro.pdf', 'text/xml', '%PDF-1.4 x'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '26. nombre de archivo con ruta/caracteres peligrosos -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', '../../etc/passwd.pdf', 'application/pdf', '%PDF-1.4 y'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '27. resumen que no es objeto JSON -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'r.pdf', 'application/pdf', '%PDF-1.4 z'::bytea, '[1,2]'::jsonb) as should_fail;
rollback;

\echo '28. tope de 30 archivos por hora por enlace -> el 31 falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'n' || g || '.pdf', 'application/pdf', convert_to('%PDF-1.4 ' || g, 'UTF8'), '{}'::jsonb) as should_fail
from generate_series(1, 31) g;
rollback;

\echo '29. subir con token expirado -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('3', 64), 'pdf', 'x.pdf', 'application/pdf', '%PDF-1.4 e'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '30. subir con token revocado -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.portal_cliente_documento_recibir(repeat('4', 64), 'pdf', 'x.pdf', 'application/pdf', '%PDF-1.4 r'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '31. staff con sub real NO puede subir por la via del cliente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'x.pdf', 'application/pdf', '%PDF-1.4 s'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '32. anon NO puede subir'
begin;
set local role anon;
select * from despachos.portal_cliente_documento_recibir(repeat('1', 64), 'pdf', 'x.pdf', 'application/pdf', '%PDF-1.4 a'::bytea, '{}'::jsonb) as should_fail;
rollback;

\echo '=== MENSAJES ==='

\echo '33. el cliente envia un mensaje -> queda como autor cliente en SU property'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_mensaje_enviar(repeat('1', 64), '  Hola, adjunto mis facturas de julio.  ');
reset role;
select (autor = 'cliente' and cuerpo = 'Hola, adjunto mis facturas de julio.' and property_id = '00000000-0000-0000-0000-000000d08b01' and staff_user_id is null)::int as mensaje_cliente_deberia_ser_1
from despachos.portal_cliente_mensaje where cuerpo like 'Hola, adjunto%';
rollback;

\echo '34. mensaje vacio -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_mensaje_enviar(repeat('1', 64), '   ') as should_fail;
rollback;

\echo '35. mensaje de mas de 2000 caracteres -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_mensaje_enviar(repeat('1', 64), repeat('a', 2001)) as should_fail;
rollback;

\echo '36. tope de 30 mensajes por hora por cliente -> el 31 falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_mensaje_enviar(repeat('1', 64), 'm' || g) as should_fail
from generate_series(1, 31) g;
rollback;

\echo '37. mensaje con token revocado -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_mensaje_enviar(repeat('4', 64), 'hola') as should_fail;
rollback;

\echo '38. staff de A responde al cliente A -> autor despacho con su staff_user_id'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_mensaje_staff_enviar('00000000-0000-0000-0000-000000d08b01', 'Recibimos tus facturas, gracias.');
reset role;
select (autor = 'despacho' and staff_user_id = '00000000-0000-0000-0000-000000d08c01')::int as respuesta_staff_deberia_ser_1
from despachos.portal_cliente_mensaje where cuerpo = 'Recibimos tus facturas, gracias.';
rollback;

\echo '39. staff de B NO puede escribirle al cliente de A (cross-tenant)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c02', true);
select despachos.portal_mensaje_staff_enviar('00000000-0000-0000-0000-000000d08b01', 'intruso') as should_fail;
rollback;

\echo '40. staff de hoteles NO puede usar el portal en una property de hoteles'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c03', true);
select despachos.portal_mensaje_staff_enviar('00000000-0000-0000-0000-000000d08b03', 'no aplica') as should_fail;
rollback;

\echo '41. anon NO puede escribir como despacho'
begin;
set local role anon;
select despachos.portal_mensaje_staff_enviar('00000000-0000-0000-0000-000000d08b01', 'anon') as should_fail;
rollback;

\echo '42. la respuesta del staff aparece en el resumen del cliente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_mensaje_staff_enviar('00000000-0000-0000-0000-000000d08b01', 'Respuesta visible');
select set_config('request.jwt.claim.sub', '', true);
select (r->'mensajes'->-1->>'autor' = 'despacho' and r->'mensajes'->-1->>'cuerpo' = 'Respuesta visible')::int as respuesta_visible_deberia_ser_1
from (select despachos.portal_cliente_resumen(repeat('1', 64)) as r) x;
rollback;

\echo '=== ENLACES (staff) ==='

\echo '43. staff de A crea un enlace y ese token funciona de inmediato'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b01', repeat('5', 64), 'Nuevo contacto', 30);
select set_config('request.jwt.claim.sub', '', true);
select (despachos.portal_cliente_resumen(repeat('5', 64))->'cliente'->>'nombre' = 'Cliente A')::int as enlace_nuevo_funciona_deberia_ser_1;
rollback;

\echo '44. staff de B NO puede crear un enlace para el cliente de A (cross-tenant)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c02', true);
select * from despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b01', repeat('6', 64), 'intruso', 30) as should_fail;
rollback;

\echo '45. staff sin membresia NO puede crear enlaces'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c04', true);
select * from despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b01', repeat('6', 64), 'intruso', 30) as should_fail;
rollback;

\echo '46. anon NO puede crear enlaces'
begin;
set local role anon;
select * from despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b01', repeat('6', 64), 'anon', 30) as should_fail;
rollback;

\echo '47. staff de hoteles NO puede crear un enlace en una property que no es de despachos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c03', true);
select * from despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b03', repeat('6', 64), 'hotel', 30) as should_fail;
rollback;

\echo '48. vigencia fuera de rango (0 y 366 dias) -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select * from despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b01', repeat('6', 64), 'cero', 0) as should_fail;
rollback;

\echo '49. vigencia de 366 dias -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select * from despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b01', repeat('6', 64), 'largo', 366) as should_fail;
rollback;

\echo '50. hash de token mal formado al crear -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select * from despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b01', 'token-en-claro', 'x', 30) as should_fail;
rollback;

\echo '51. hash de token repetido al crear -> error (unique)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select * from despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b01', repeat('1', 64), 'duplicado', 30) as should_fail;
rollback;

\echo '52. maximo 20 enlaces vigentes por cliente -> el 21 falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_enlace_crear('00000000-0000-0000-0000-000000d08b01', encode(sha256(convert_to('tope' || g, 'UTF8')), 'hex'), 'e' || g, 30) as should_fail
from generate_series(1, 20) g;
rollback;

\echo '53. staff de B NO puede revocar el enlace de A (cross-tenant)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c02', true);
select despachos.portal_enlace_revocar('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08e01') as should_fail;
rollback;

\echo '54. revocar es idempotente: la segunda vez devuelve false'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_enlace_revocar('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08e01');
select (despachos.portal_enlace_revocar('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08e01') = false)::int as segunda_revocacion_deberia_ser_1;
rollback;

\echo '55. revocar con la property equivocada (enlace de A, property de B) no revoca nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c02', true);
select (despachos.portal_enlace_revocar('00000000-0000-0000-0000-000000d08b02', '00000000-0000-0000-0000-000000d08e01') = false)::int as property_cruzada_no_revoca_deberia_ser_1;
rollback;

\echo '=== DOCUMENTOS (staff) ==='

\echo '56. staff de A obtiene el contenido de un documento de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select (out_contenido = '%PDF-A'::bytea and out_estado = 'recibido')::int as contenido_staff_deberia_ser_1
from despachos.portal_documento_contenido('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08f01');
rollback;

\echo '57. staff de B NO obtiene el contenido de un documento de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c02', true);
select * from despachos.portal_documento_contenido('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08f01') as should_fail;
rollback;

\echo '58. staff de A con la property de B + documento de A -> cero filas (no cruza properties)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c02', true);
select (count(*) = 0)::int as sin_filas_cruzadas_deberia_ser_1
from despachos.portal_documento_contenido('00000000-0000-0000-0000-000000d08b02', '00000000-0000-0000-0000-000000d08f01');
rollback;

\echo '59. aceptar un documento recibido vinculandolo a un CFDI de la misma property'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select (despachos.portal_documento_resolver('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08f01', 'aceptado', null, '00000000-0000-0000-0000-000000d08d01') = true)::int as aceptado_deberia_ser_1;
rollback;

\echo '60. una segunda resolucion del mismo documento devuelve false (ya resuelto)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_documento_resolver('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08f01', 'rechazado', 'ilegible', null);
select (despachos.portal_documento_resolver('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08f01', 'aceptado', null, null) = false)::int as doble_resolucion_deberia_ser_1;
rollback;

\echo '61. vincular un documento a un CFDI de OTRA property -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_documento_resolver('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08f01', 'aceptado', null, '00000000-0000-0000-0000-000000d08d02') as should_fail;
rollback;

\echo '62. staff de B NO puede resolver un documento de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c02', true);
select despachos.portal_documento_resolver('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08f01', 'rechazado', 'x', null) as should_fail;
rollback;

\echo '63. estado de resolucion invalido -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select despachos.portal_documento_resolver('00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08f01', 'recibido', null, null) as should_fail;
rollback;

\echo '=== ACCESO DIRECTO A TABLAS ==='

\echo '64. staff de A lista SOLO los enlaces de SU cliente (3 de A; ninguno de B)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select (count(*) = 3 and bool_and(property_id = '00000000-0000-0000-0000-000000d08b01'))::int as enlaces_propios_deberia_ser_1
from despachos.portal_cliente_enlace;
rollback;

\echo '65. staff NO puede leer la columna token_hash'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select token_hash as should_fail from despachos.portal_cliente_enlace;
rollback;

\echo '66. staff NO puede hacer select * del enlace (incluye token_hash)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select * from despachos.portal_cliente_enlace as should_fail;
rollback;

\echo '67. staff lista las columnas seguras del enlace'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select (count(*) = 3)::int as columnas_seguras_deberia_ser_1 from (select id, etiqueta, expira_en, revocado_en, usos from despachos.portal_cliente_enlace) x;
rollback;

\echo '68. staff NO puede leer la columna contenido del documento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select contenido as should_fail from despachos.portal_cliente_documento;
rollback;

\echo '69. staff de A solo ve los documentos de SU cliente (metadatos)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select (count(*) = 1 and bool_and(property_id = '00000000-0000-0000-0000-000000d08b01'))::int as documentos_propios_deberia_ser_1
from (select id, property_id, nombre_archivo, estado from despachos.portal_cliente_documento) x;
rollback;

\echo '70. staff de A solo ve los mensajes de SU cliente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
select (count(*) = 1 and bool_and(cuerpo = 'mensaje-del-cliente-A'))::int as mensajes_propios_deberia_ser_1
from despachos.portal_cliente_mensaje;
rollback;

\echo '71. staff sin membresia no ve ningun enlace'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c04', true);
select (count(*) = 0)::int as sin_enlaces_deberia_ser_1 from despachos.portal_cliente_enlace;
rollback;

\echo '72. staff NO puede insertar directo un enlace'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
insert into despachos.portal_cliente_enlace (organization_id, property_id, token_hash, etiqueta, creado_por, expira_en)
values ('00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', repeat('7', 64), 'directo', '00000000-0000-0000-0000-000000d08c01', now() + interval '1 day') returning 1 as should_fail;
rollback;

\echo '73. staff NO puede actualizar directo un enlace (reactivarlo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
update despachos.portal_cliente_enlace set revocado_en = null, expira_en = now() + interval '300 days' where id = '00000000-0000-0000-0000-000000d08e04' returning 1 as should_fail;
rollback;

\echo '74. staff NO puede insertar directo un documento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
insert into despachos.portal_cliente_documento (organization_id, property_id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, sha256, contenido)
values ('00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', '00000000-0000-0000-0000-000000d08e01', 'pdf', 'x.pdf', 'application/pdf', 1, repeat('a', 64), '%'::bytea) returning 1 as should_fail;
rollback;

\echo '75. staff NO puede borrar directo un mensaje'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
delete from despachos.portal_cliente_mensaje returning 1 as should_fail;
rollback;

\echo '76. staff NO puede insertar directo un mensaje'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d08c01', true);
insert into despachos.portal_cliente_mensaje (organization_id, property_id, autor, cuerpo)
values ('00000000-0000-0000-0000-000000d08a01', '00000000-0000-0000-0000-000000d08b01', 'despacho', 'directo') returning 1 as should_fail;
rollback;

\echo '77. anon NO puede leer enlaces'
begin;
set local role anon;
select count(*) as should_fail from despachos.portal_cliente_enlace;
rollback;

\echo '78. anon NO puede leer documentos'
begin;
set local role anon;
select count(*) as should_fail from despachos.portal_cliente_documento;
rollback;

\echo '79. anon NO puede leer mensajes'
begin;
set local role anon;
select count(*) as should_fail from despachos.portal_cliente_mensaje;
rollback;

\echo '80. el helper interno de resolucion NO es ejecutable por authenticated'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.portal_cliente_enlace_resolver(repeat('1', 64)) as should_fail;
rollback;
