-- Fixtures + escenarios contra Postgres REAL del seed demo de citas (bloque plpgsql generado arriba: public.seed_citas_demo()).
-- Cada escenario corre en su propio `begin; ... rollback;` y ejecuta el seed dentro de la transaccion. Convenciones del gate
-- (scripts/verify-real-postgres-ci/run-gate.mjs): `should_fail` = el escenario debe terminar en ERROR; `..._deberia_ser_N` = el
-- valor de esa consulta debe ser N.
--
--   A. Resultado: 2 organizaciones demo marcadas, catalogo, clientes ficticios (@example.test), citas en TODOS los estados
--      dentro del horario del profesional (hora local en America/Merida), pasadas/futuras coherentes y lista de espera completa.
--   B. Idempotencia: dos corridas no duplican ni mueven nada; la fecha base fija las semanas.
--   C. Aislamiento y RLS: otra organizacion con los mismos nombres/telefonos queda intacta; staff ajeno y anon no leen lo
--      sembrado; nadie de la aplicacion escribe la marca demo.
--   D. Limpieza: solo borra organizaciones marcadas (la otra queda intacta); denegada a anon/authenticated y con auth.uid().
--   E. Seguridad del seed: aborta ante un slug de otra vertical, ante una cuenta de citas NO demo y sin usuario owner.
\set ON_ERROR_STOP off
\pset pager off

-- GENERADO: funciones con el cuerpo real del seed (packages/domain-citas/src/seed/citas-demo.ts). No editar a mano:
-- node --experimental-strip-types scripts/verify-citas-demo/generar-assertions.ts
create or replace function public.seed_citas_demo() returns void language plpgsql as $seed_fn$
declare
  v jsonb := $citas${"seedVersion":"citas-demo-1","negocios":[{"slug":"clinica-dental-sonrisa-demo","nombre":"Clínica Dental Sonrisa (demo)","rubro":"dental","timezone":"America/Merida","sucursal":"Sucursal Centro (demo)","servicios":[{"nombre":"Limpieza dental","minutos":45,"precioCentavos":60000},{"nombre":"Consulta de valoración","minutos":30,"precioCentavos":40000},{"nombre":"Resina o empaste","minutos":60,"precioCentavos":120000},{"nombre":"Blanqueamiento","minutos":90,"precioCentavos":350000}],"proveedores":[{"nombre":"Dra. Ana Lozano","rol":"Odontóloga general","servicios":["Limpieza dental","Consulta de valoración","Resina o empaste"],"reglas":[{"dow":1,"inicio":"09:00","fin":"14:00"},{"dow":1,"inicio":"16:00","fin":"19:00"},{"dow":2,"inicio":"09:00","fin":"14:00"},{"dow":2,"inicio":"16:00","fin":"19:00"},{"dow":3,"inicio":"09:00","fin":"14:00"},{"dow":3,"inicio":"16:00","fin":"19:00"},{"dow":4,"inicio":"09:00","fin":"14:00"},{"dow":4,"inicio":"16:00","fin":"19:00"},{"dow":5,"inicio":"09:00","fin":"14:00"},{"dow":5,"inicio":"16:00","fin":"19:00"}]},{"nombre":"Dr. Luis Pech","rol":"Endodoncista","servicios":["Limpieza dental","Consulta de valoración","Resina o empaste"],"reglas":[{"dow":2,"inicio":"10:00","fin":"18:00"},{"dow":3,"inicio":"10:00","fin":"18:00"},{"dow":4,"inicio":"10:00","fin":"18:00"},{"dow":5,"inicio":"10:00","fin":"18:00"},{"dow":6,"inicio":"10:00","fin":"18:00"}]},{"nombre":"Dra. Marisol Canché","rol":"Higienista","servicios":["Limpieza dental","Blanqueamiento"],"reglas":[{"dow":1,"inicio":"09:00","fin":"15:00"},{"dow":3,"inicio":"09:00","fin":"15:00"},{"dow":5,"inicio":"09:00","fin":"15:00"}]}],"excepciones":[{"proveedor":"Dra. Ana Lozano","semana":1,"dow":3,"cerrado":true,"inicio":null,"fin":null,"motivo":"Capacitación (demo)"},{"proveedor":"Dr. Luis Pech","semana":2,"dow":6,"cerrado":false,"inicio":"10:00","fin":"14:00","motivo":"Medio día (demo)"},{"proveedor":"Dra. Marisol Canché","semana":1,"dow":1,"cerrado":true,"inicio":null,"fin":null,"motivo":"Día inhábil (demo)"}],"clientes":[{"nombre":"Sofía Canul Ek","telefono":"5200101000","email":"sofia.canul@example.test"},{"nombre":"Marco Uc Pech","telefono":"5200101001","email":"marco.uc@example.test"},{"nombre":"Lucía Pech Dzul","telefono":"5200101002","email":"lucia.pech@example.test"},{"nombre":"Iván Cen Tun","telefono":"5200101003","email":"ivan.cen@example.test"},{"nombre":"Paola Chan Kú","telefono":"5200101004","email":"paola.chan@example.test"},{"nombre":"Elena Dzul Cab","telefono":"5200101005","email":"elena.dzul@example.test"},{"nombre":"Tomás Kú Moo","telefono":"5200101006","email":"tomas.ku@example.test"},{"nombre":"Carmen Euán Aké","telefono":"5200101007","email":"carmen.euan@example.test"},{"nombre":"Hugo Ay Tzec","telefono":"5200101008","email":"hugo.ay@example.test"},{"nombre":"Fabiola Ku Cauich","telefono":"5200101009","email":"fabiola.ku@example.test"}],"citas":[{"clave":"d01","idempotencyKey":"c3c2c776ab7f154de0c685fcaff9ef9024a11168a9d0bd3838568dcb25a7df94","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101000","semana":-3,"dow":1,"hora":"09:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"d02","idempotencyKey":"91f1edeac5edaa76cd8794a508d0c768e94bb6a71bdf28b0e3e1713df83fb718","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101001","semana":-3,"dow":2,"hora":"10:00","estado":"completed","origen":"voice","notas":null},{"clave":"d03","idempotencyKey":"b93263a8ca66c41b9479bde660dbe5bea60beb3dc3c73b31c8bc08c053d5ad61","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101002","semana":-3,"dow":3,"hora":"11:00","estado":"completed","origen":"manual","notas":"Molar superior derecho"},{"clave":"d04","idempotencyKey":"b28ca984305d98b5cc43924ec94374d6a39a0c2ce4b01d4d063d80359bcbb2f5","proveedor":"Dra. Marisol Canché","servicio":"Blanqueamiento","telefono":"5200101003","semana":-3,"dow":3,"hora":"09:30","estado":"completed","origen":"web","notas":null},{"clave":"d05","idempotencyKey":"38cd410a899a4b5c1ec7633e81ea42ab633713bb7ec32a57e263041dbfc56aa8","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101004","semana":-3,"dow":4,"hora":"16:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"d06","idempotencyKey":"e96fee2a3934245a4e46d03744c545ce5123a19ceb82f212af83628254d22af7","proveedor":"Dr. Luis Pech","servicio":"Consulta de valoración","telefono":"5200101005","semana":-2,"dow":2,"hora":"12:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"d07","idempotencyKey":"53295a4367e3b7893b0c78db9ae009f45603e88ed53cff7eb47b44d17fdaf86f","proveedor":"Dra. Marisol Canché","servicio":"Limpieza dental","telefono":"5200101006","semana":-2,"dow":1,"hora":"10:00","estado":"completed","origen":"web","notas":null},{"clave":"d08","idempotencyKey":"be2bbb16dd5280dc82fca4f01724ab111c1dfdacf3a45f22c5af0494de78ade2","proveedor":"Dra. Ana Lozano","servicio":"Resina o empaste","telefono":"5200101000","semana":-2,"dow":5,"hora":"17:00","estado":"completed","origen":"manual","notas":null},{"clave":"d09","idempotencyKey":"c41090339ead4ec92fc74360cd5e141dedc0d494e545a3f7f290bedc020b69bc","proveedor":"Dr. Luis Pech","servicio":"Limpieza dental","telefono":"5200101007","semana":-2,"dow":6,"hora":"10:30","estado":"no_show","origen":"voice","notas":null},{"clave":"d10","idempotencyKey":"6c30e5634be60467a3b18cdd5a996b3e660a40843779f055cde3d043ab29044d","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101008","semana":-2,"dow":3,"hora":"09:00","estado":"cancelled","origen":"whatsapp","notas":"Avisó que tenía junta"},{"clave":"d11","idempotencyKey":"76e90ff23c655ed0de9ab30993fa023c8cfebaf4914ee56a78e7986fc8fd8a0b","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101001","semana":-1,"dow":1,"hora":"09:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"d12","idempotencyKey":"e54ae2fbea0e0577f6abd7e9559c1ac258cb70341b5d9c8ced8756a6ad865507","proveedor":"Dra. Marisol Canché","servicio":"Blanqueamiento","telefono":"5200101009","semana":-1,"dow":5,"hora":"09:00","estado":"completed","origen":"web","notas":null},{"clave":"d13","idempotencyKey":"778513984390c817595952b2c45894265ca2775db558db403e8f7feb19020b9c","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101003","semana":-1,"dow":4,"hora":"14:00","estado":"completed","origen":"voice","notas":null},{"clave":"d14","idempotencyKey":"ec1c63b04f07b2a986c4b772e2f1c922fda2fedf8c9addc1c7c3bed6d99e9ad1","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101002","semana":-1,"dow":2,"hora":"16:30","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"d15","idempotencyKey":"e543e22896393abd970ea5f902f4014b524b626fff2845339784735a85ea630b","proveedor":"Dr. Luis Pech","servicio":"Consulta de valoración","telefono":"5200101004","semana":-1,"dow":3,"hora":"10:00","estado":"cancelled","origen":"web","notas":null},{"clave":"d16","idempotencyKey":"a5787693018708c8fb423587529ada21a838f988d8cca8c6bd7784148c6e00ee","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101005","semana":1,"dow":1,"hora":"09:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"d17","idempotencyKey":"3bcc7e91d8b921728b48a3e2bdb663e8c94e426c63750b3430afe730e79ad182","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101006","semana":1,"dow":2,"hora":"11:00","estado":"confirmed","origen":"manual","notas":null},{"clave":"d18","idempotencyKey":"e191073577847f1e1c995aa312418f3af380e1127cb2a8708068f9478dce1da4","proveedor":"Dra. Marisol Canché","servicio":"Limpieza dental","telefono":"5200101007","semana":1,"dow":3,"hora":"10:00","estado":"pending","origen":"web","notas":null},{"clave":"d19","idempotencyKey":"68811ff82e8825137fb9da6dc9d9f7b7a1ec134dd5324624435fbdb0d1f59011","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101000","semana":1,"dow":4,"hora":"17:00","estado":"pending","origen":"whatsapp","notas":null},{"clave":"d20","idempotencyKey":"cf26eb5d80937cf6bdb28501f22944fec1bf8b3f404d6170a57dcfb6a026b482","proveedor":"Dr. Luis Pech","servicio":"Consulta de valoración","telefono":"5200101008","semana":1,"dow":5,"hora":"15:00","estado":"confirmed","origen":"voice","notas":null},{"clave":"d21","idempotencyKey":"febc71339aaf4f902db907134101d72b7c5edac6a4e5f85044f3756817a71747","proveedor":"Dra. Marisol Canché","servicio":"Blanqueamiento","telefono":"5200101009","semana":1,"dow":5,"hora":"11:00","estado":"cancelled","origen":"web","notas":null},{"clave":"d22","idempotencyKey":"e184151fb7a86b2eaab47b39735ae3208c869161e9b522ea64b7b98b5de8ed87","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101001","semana":2,"dow":2,"hora":"10:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"d23","idempotencyKey":"8e0a4efb5f21f7a9661cdcb695a152f3609f8655ed675a9e7c5c791b251f151a","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101002","semana":2,"dow":6,"hora":"13:00","estado":"pending","origen":"manual","notas":null},{"clave":"d24","idempotencyKey":"bda11e025f55d7eb6160cba97f3ed9d6ffc398d6cfb0f1e0a24cdb145c4969ed","proveedor":"Dra. Marisol Canché","servicio":"Limpieza dental","telefono":"5200101003","semana":2,"dow":1,"hora":"09:00","estado":"confirmed","origen":"web","notas":null},{"clave":"d25","idempotencyKey":"3a8b2ffccca229c9490030e370935769d9c3507a3d803c1e00f76c7196fa096f","proveedor":"Dra. Ana Lozano","servicio":"Resina o empaste","telefono":"5200101004","semana":2,"dow":4,"hora":"09:00","estado":"confirmed","origen":"whatsapp","notas":null}],"espera":[{"telefono":"5200101050","nombre":"Andrea Pat Mex","servicio":"Limpieza dental","proveedor":"Dra. Ana Lozano","desde":[1,1],"hasta":[1,5],"ventana":"morning","estado":"active"},{"telefono":"5200101051","nombre":"Raúl Cupul Ix","servicio":"Consulta de valoración","proveedor":null,"desde":[1,1],"hasta":[2,5],"ventana":"any","estado":"notified"},{"telefono":"5200101052","nombre":"Diana Balam Hau","servicio":"Resina o empaste","proveedor":"Dr. Luis Pech","desde":[-1,1],"hasta":[-1,5],"ventana":"afternoon","estado":"fulfilled"},{"telefono":"5200101053","nombre":"Víctor Ek Naal","servicio":"Blanqueamiento","proveedor":"Dra. Marisol Canché","desde":[1,1],"hasta":[2,5],"ventana":"any","estado":"cancelled"},{"telefono":"5200101054","nombre":"Mireya Tuz Xool","servicio":"Limpieza dental","proveedor":null,"desde":[-3,1],"hasta":[-3,5],"ventana":"evening","estado":"expired"}]},{"slug":"barberia-el-filo-demo","nombre":"Barbería El Filo (demo)","rubro":"barberia","timezone":"America/Merida","sucursal":"Sucursal Norte (demo)","servicios":[{"nombre":"Corte de cabello","minutos":30,"precioCentavos":25000},{"nombre":"Arreglo de barba","minutos":20,"precioCentavos":15000},{"nombre":"Corte y barba","minutos":45,"precioCentavos":35000},{"nombre":"Afeitado clásico","minutos":30,"precioCentavos":20000}],"proveedores":[{"nombre":"Beto","rol":"Barbero","servicios":["Corte de cabello","Arreglo de barba","Corte y barba","Afeitado clásico"],"reglas":[{"dow":2,"inicio":"10:00","fin":"20:00"},{"dow":3,"inicio":"10:00","fin":"20:00"},{"dow":4,"inicio":"10:00","fin":"20:00"},{"dow":5,"inicio":"10:00","fin":"20:00"},{"dow":6,"inicio":"10:00","fin":"20:00"}]},{"nombre":"Chuy","rol":"Barbero","servicios":["Corte de cabello","Arreglo de barba","Corte y barba"],"reglas":[{"dow":1,"inicio":"11:00","fin":"19:00"},{"dow":2,"inicio":"11:00","fin":"19:00"},{"dow":3,"inicio":"11:00","fin":"19:00"},{"dow":4,"inicio":"11:00","fin":"19:00"},{"dow":5,"inicio":"11:00","fin":"19:00"}]},{"nombre":"Memo","rol":"Barbero","servicios":["Corte de cabello","Afeitado clásico"],"reglas":[{"dow":4,"inicio":"12:00","fin":"21:00"},{"dow":5,"inicio":"12:00","fin":"21:00"},{"dow":6,"inicio":"12:00","fin":"21:00"}]}],"excepciones":[{"proveedor":"Beto","semana":1,"dow":5,"cerrado":true,"inicio":null,"fin":null,"motivo":"Descanso (demo)"},{"proveedor":"Chuy","semana":2,"dow":5,"cerrado":false,"inicio":"11:00","fin":"15:00","motivo":"Salida temprano (demo)"}],"clientes":[{"nombre":"Daniel Tun May","telefono":"5200201000","email":"daniel.tun@example.test"},{"nombre":"Rodrigo Pool Be","telefono":"5200201001","email":"rodrigo.pool@example.test"},{"nombre":"Erick Moo Cob","telefono":"5200201002","email":"erick.moo@example.test"},{"nombre":"Pedro Tzec Ake","telefono":"5200201003","email":"pedro.tzec@example.test"},{"nombre":"Memo Aké Dzib","telefono":"5200201004","email":"memo.ake@example.test"},{"nombre":"Sergio Mex Poot","telefono":"5200201005","email":"sergio.mex@example.test"},{"nombre":"Luis Ake Chi","telefono":"5200201006","email":"luis.ake@example.test"},{"nombre":"Iker Dzul Uc","telefono":"5200201007","email":"iker.dzul@example.test"},{"nombre":"Beto Sosa Cetz","telefono":"5200201008","email":"beto.sosa@example.test"},{"nombre":"Julio Cab Yam","telefono":"5200201009","email":"julio.cab@example.test"}],"citas":[{"clave":"b01","idempotencyKey":"d1dd3298683efc6578020679f9b01c6ea9b54849dd32a954312129b4ab73d537","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201000","semana":-3,"dow":2,"hora":"10:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b02","idempotencyKey":"6b334e9ab08c7ab0c5c736a7a6d72e6d9aae863b054a3ad99d18892f0ccfb79b","proveedor":"Chuy","servicio":"Corte y barba","telefono":"5200201001","semana":-3,"dow":1,"hora":"11:00","estado":"completed","origen":"web","notas":null},{"clave":"b03","idempotencyKey":"7f00f7b1ea8135381d606e441bbfbb9dd28455a4a003ddb192f1911555aa3ec3","proveedor":"Memo","servicio":"Afeitado clásico","telefono":"5200201002","semana":-3,"dow":4,"hora":"12:00","estado":"completed","origen":"manual","notas":null},{"clave":"b04","idempotencyKey":"7f432d4304ff37e861eb9491daa1014042e1dcb515d36fe518c45fd08defe316","proveedor":"Beto","servicio":"Arreglo de barba","telefono":"5200201003","semana":-3,"dow":6,"hora":"15:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"b05","idempotencyKey":"5ec9e9d55b522068f5e2133245781447044b3682de888d64dfcc0242cc38fc76","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201004","semana":-3,"dow":3,"hora":"17:00","estado":"completed","origen":"voice","notas":null},{"clave":"b06","idempotencyKey":"23165ee18227706d774e4658682cad4935d6af0ad8ab07cc43e55ec3134aab22","proveedor":"Beto","servicio":"Corte y barba","telefono":"5200201005","semana":-2,"dow":2,"hora":"18:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b07","idempotencyKey":"9b5251ecd9c89580736c747c166af1ed153f755baa7cc954c10d9683f2677d2f","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201006","semana":-2,"dow":5,"hora":"11:30","estado":"completed","origen":"web","notas":null},{"clave":"b08","idempotencyKey":"88c5e413cd5312d0e8b6e60fd994f87e472223862a296e955632e73ebe377bd8","proveedor":"Memo","servicio":"Corte de cabello","telefono":"5200201007","semana":-2,"dow":6,"hora":"19:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b09","idempotencyKey":"441851fc1fc767b7c323fc2f4c836022a479c571cd320688fdaf1d65c45cf133","proveedor":"Beto","servicio":"Afeitado clásico","telefono":"5200201000","semana":-2,"dow":4,"hora":"10:30","estado":"cancelled","origen":"manual","notas":"Pidió cambiar de día"},{"clave":"b10","idempotencyKey":"5d97fb52775e47cdf2aa3c03ecb3101da21dadbe6f857d8f75e974ed6b646c4e","proveedor":"Chuy","servicio":"Arreglo de barba","telefono":"5200201008","semana":-2,"dow":1,"hora":"15:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"b11","idempotencyKey":"c469d63792ce4f8be979ae232812bb94342b77754674cd406c45d5d35761b744","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201001","semana":-1,"dow":3,"hora":"10:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b12","idempotencyKey":"d511de1ce852164ccabda421da6c06a6942cbc71011ae18dda5c654e37e1b507","proveedor":"Chuy","servicio":"Corte y barba","telefono":"5200201009","semana":-1,"dow":2,"hora":"13:00","estado":"completed","origen":"web","notas":null},{"clave":"b13","idempotencyKey":"e4d37831810563f99d734e29793744844ebcc3cf4f2aa519434f6d82f7d7b54f","proveedor":"Memo","servicio":"Corte de cabello","telefono":"5200201002","semana":-1,"dow":4,"hora":"12:30","estado":"completed","origen":"voice","notas":null},{"clave":"b14","idempotencyKey":"f1de19db5ebafb4b3aabac5c4606bf27c42cef16230982ae7656a880a4fe014a","proveedor":"Beto","servicio":"Corte y barba","telefono":"5200201003","semana":-1,"dow":5,"hora":"16:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"b15","idempotencyKey":"15fe586adc2db5a6454285e1c4d7757c2ccfc81acc3b408474b63f906a1311e7","proveedor":"Chuy","servicio":"Arreglo de barba","telefono":"5200201004","semana":-1,"dow":4,"hora":"18:00","estado":"cancelled","origen":"web","notas":null},{"clave":"b16","idempotencyKey":"2db1e4ea3c0058432a1bdf9295f82af3871b6ca1aa0a6433b3d683bd9fff80e3","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201005","semana":1,"dow":2,"hora":"10:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"b17","idempotencyKey":"e8badc02d5fdd3288aa998a32ce29684bf5fd46cbbe8d1a4cbd0610682564026","proveedor":"Chuy","servicio":"Corte y barba","telefono":"5200201006","semana":1,"dow":3,"hora":"14:00","estado":"confirmed","origen":"web","notas":null},{"clave":"b18","idempotencyKey":"e18377b9d36e5fb3fb559ea22d68dcea0505a4d8b6b4629e4286e47b670b75a1","proveedor":"Memo","servicio":"Corte de cabello","telefono":"5200201007","semana":1,"dow":4,"hora":"13:00","estado":"pending","origen":"whatsapp","notas":null},{"clave":"b19","idempotencyKey":"fe8cbf2230e1f943ae1a88e366d450c21a6885eda59494a44771707e2e0fcbda","proveedor":"Beto","servicio":"Arreglo de barba","telefono":"5200201008","semana":1,"dow":6,"hora":"12:00","estado":"pending","origen":"voice","notas":null},{"clave":"b20","idempotencyKey":"92448768828e928a8c7a499a42cb8dc0f62d96a4f5f859aedb13c9ec98e47b5b","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201009","semana":1,"dow":1,"hora":"11:00","estado":"cancelled","origen":"manual","notas":null},{"clave":"b21","idempotencyKey":"a6545235841c082ab4ee09bf4ea34a0c738fa1efd08dcd55ca1f7733b9eb4992","proveedor":"Beto","servicio":"Corte y barba","telefono":"5200201000","semana":2,"dow":2,"hora":"17:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"b22","idempotencyKey":"f3cbbffe8b1a7df13f530983c3e3d62a68a34df8497884144c39ee018a93161b","proveedor":"Memo","servicio":"Afeitado clásico","telefono":"5200201001","semana":2,"dow":5,"hora":"19:30","estado":"confirmed","origen":"web","notas":null},{"clave":"b23","idempotencyKey":"67203ea92f972e185f5cb24ff5ad7ab3f929bf65159b824b1a797e5d10ccaf46","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201002","semana":2,"dow":3,"hora":"11:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"b24","idempotencyKey":"08500a861340521456f57ed64f9bc4d72ca40735b1983c1c3ba3357707d40d84","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201003","semana":2,"dow":6,"hora":"10:00","estado":"pending","origen":"manual","notas":null}],"espera":[{"telefono":"5200201050","nombre":"Ramón Che Pat","servicio":"Corte de cabello","proveedor":"Beto","desde":[1,2],"hasta":[1,6],"ventana":"afternoon","estado":"active"},{"telefono":"5200201051","nombre":"Gael Puc Nah","servicio":"Corte y barba","proveedor":null,"desde":[1,2],"hasta":[2,6],"ventana":"any","estado":"notified"},{"telefono":"5200201052","nombre":"Ismael Ucán Kú","servicio":"Afeitado clásico","proveedor":"Memo","desde":[-1,4],"hasta":[-1,6],"ventana":"evening","estado":"fulfilled"},{"telefono":"5200201053","nombre":"Octavio Mis Tun","servicio":"Arreglo de barba","proveedor":"Chuy","desde":[1,1],"hasta":[2,5],"ventana":"morning","estado":"cancelled"},{"telefono":"5200201054","nombre":"Néstor Cen Aké","servicio":"Corte de cabello","proveedor":null,"desde":[-3,1],"hasta":[-3,6],"ventana":"any","estado":"expired"}]}]}$citas$::jsonb;
  neg jsonb;
  v_org uuid;
  v_vertical text;
  v_marcada boolean;
  v_prop uuid;
  v_user uuid;
  v_tz text;
  v_lunes date;
  v_base date := null;
begin
  select id into v_user from core.staff_user where lower(email) = 'owner-demo@example.test';
  if v_user is null then
    raise exception 'seed-citas: no existe un usuario de staff con el correo indicado (--owner-email); el seed no crea credenciales.';
  end if;

  for neg in select * from jsonb_array_elements(v->'negocios') loop
    v_tz := neg->>'timezone';
    v_lunes := date_trunc('week', coalesce(v_base, (now() at time zone v_tz)::date)::timestamp)::date;

    -- 1) organizacion: solo se crea o se actualiza una cuenta DEMO de citas; cualquier otra con ese slug aborta.
    select id, vertical into v_org, v_vertical from core.organization where slug = neg->>'slug';
    if v_org is not null then
      select exists (select 1 from citas.demo_organization d where d.organization_id = v_org) into v_marcada;
      if v_vertical <> 'citas' or not v_marcada then
        raise exception 'seed-citas: el slug % ya existe y no es una cuenta demo de citas; no se toca.', neg->>'slug';
      end if;
      update core.organization set name = neg->>'nombre' where id = v_org;
    else
      insert into core.organization (vertical, name, slug) values ('citas', neg->>'nombre', neg->>'slug') returning id into v_org;
    end if;
    insert into citas.demo_organization (organization_id, seed_version) values (v_org, v->>'seedVersion')
      on conflict (organization_id) do update set seed_version = excluded.seed_version;

    insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
      values (v_user, v_org, null, 'owner', 'owner')
      on conflict do nothing;

    -- 2) sucursal, configuracion y zona horaria
    select id into v_prop from core.property where organization_id = v_org and name = neg->>'sucursal';
    if v_prop is null then
      insert into core.property (organization_id, vertical, name, status) values (v_org, 'citas', neg->>'sucursal', 'active') returning id into v_prop;
    end if;
    insert into citas.tenant_config (organization_id, rubro, default_timezone) values (v_org, neg->>'rubro', v_tz)
      on conflict (organization_id) do update set rubro = excluded.rubro, default_timezone = excluded.default_timezone, updated_at = now();
    insert into citas.property_config (property_id, organization_id, timezone) values (v_prop, v_org, v_tz)
      on conflict (property_id) do update set timezone = excluded.timezone;

    -- 3) servicios (por nombre)
    update citas.services s set duration_minutes = x.minutos, price_cents = x."precioCentavos", is_active = true, updated_at = now()
      from jsonb_to_recordset(neg->'servicios') as x(nombre text, minutos int, "precioCentavos" int)
      where s.organization_id = v_org and s.name = x.nombre;
    insert into citas.services (organization_id, name, duration_minutes, price_cents)
      select v_org, x.nombre, x.minutos, x."precioCentavos"
      from jsonb_to_recordset(neg->'servicios') as x(nombre text, minutos int, "precioCentavos" int)
      where not exists (select 1 from citas.services s where s.organization_id = v_org and s.name = x.nombre);

    -- 4) proveedores (por nombre) y los servicios que ofrece cada uno
    update citas.providers p set role_label = x.rol, property_id = v_prop, is_active = true, updated_at = now()
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, rol text)
      where p.organization_id = v_org and p.display_name = x.nombre;
    insert into citas.providers (organization_id, property_id, display_name, role_label)
      select v_org, v_prop, x.nombre, x.rol
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, rol text)
      where not exists (select 1 from citas.providers p where p.organization_id = v_org and p.display_name = x.nombre);
    insert into citas.provider_services (provider_id, service_id)
      select p.id, s.id
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, servicios jsonb)
      join citas.providers p on p.organization_id = v_org and p.display_name = x.nombre
      cross join lateral jsonb_array_elements_text(x.servicios) as sn(nombre)
      join citas.services s on s.organization_id = v_org and s.name = sn.nombre
      on conflict do nothing;

    -- 5) horario semanal (se reescribe: solo existe en esta organizacion demo) y excepciones
    delete from citas.availability_rules r using citas.providers p
      where r.provider_id = p.id and p.organization_id = v_org;
    insert into citas.availability_rules (provider_id, day_of_week, start_time, end_time)
      select p.id, r.dow, r.inicio::time, r.fin::time
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, reglas jsonb)
      join citas.providers p on p.organization_id = v_org and p.display_name = x.nombre
      cross join lateral jsonb_to_recordset(x.reglas) as r(dow int, inicio text, fin text);
    insert into citas.availability_overrides (provider_id, override_date, is_closed, start_time, end_time, reason)
      select p.id, v_lunes + (e.semana * 7) + (case when e.dow = 0 then 6 else e.dow - 1 end), e.cerrado, e.inicio::time, e.fin::time, e.motivo
      from jsonb_to_recordset(neg->'excepciones') as e(proveedor text, semana int, dow int, cerrado boolean, inicio text, fin text, motivo text)
      join citas.providers p on p.organization_id = v_org and p.display_name = e.proveedor
      on conflict (provider_id, override_date) do update set is_closed = excluded.is_closed, start_time = excluded.start_time,
        end_time = excluded.end_time, reason = excluded.reason;

    -- 6) clientes ficticios (por organizacion + telefono)
    insert into citas.customers (organization_id, full_name, phone, email)
      select v_org, c.nombre, c.telefono, c.email
      from jsonb_to_recordset(neg->'clientes') as c(nombre text, telefono text, email text)
      on conflict (organization_id, phone) do update set full_name = excluded.full_name, email = excluded.email, updated_at = now();

    -- 7) citas: llave de idempotencia determinista; re-ejecutar no duplica ni mueve las ya sembradas
    insert into citas.appointments (organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, notes, idempotency_key, reminder_24h_sent_at)
      select v_org, v_prop, p.id, s.id, cu.id, st.t, st.t + make_interval(mins => s.duration_minutes), a.estado, a.origen, a.notas, a."idempotencyKey",
             case when a.semana < 0 and a.estado in ('completed', 'no_show') then st.t - interval '24 hours' else null end
      from jsonb_to_recordset(neg->'citas') as a(clave text, "idempotencyKey" text, proveedor text, servicio text, telefono text, semana int, dow int, hora text, estado text, origen text, notas text)
      join citas.providers p on p.organization_id = v_org and p.display_name = a.proveedor
      join citas.services s on s.organization_id = v_org and s.name = a.servicio
      join citas.customers cu on cu.organization_id = v_org and cu.phone = a.telefono
      cross join lateral (select ((v_lunes + (a.semana * 7) + (case when a.dow = 0 then 6 else a.dow - 1 end)) + a.hora::time) at time zone v_tz as t) st
      on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing;

    -- 8) lista de espera (por organizacion + telefono ficticio)
    insert into citas.appointment_waitlist (organization_id, customer_phone, customer_name, service_id, provider_id, preferred_date_from, preferred_date_to,
                                            preferred_time_window, status, notified_count, last_notified_at, expires_at)
      select v_org, w.telefono, w.nombre, s.id, p.id,
             v_lunes + (w.desde[1] * 7) + (case when w.desde[2] = 0 then 6 else w.desde[2] - 1 end),
             v_lunes + (w.hasta[1] * 7) + (case when w.hasta[2] = 0 then 6 else w.hasta[2] - 1 end),
             w.ventana, w.estado,
             case when w.estado in ('notified', 'fulfilled') then 1 else 0 end,
             case when w.estado in ('notified', 'fulfilled') then now() - interval '1 day' else null end,
             case when w.estado = 'expired' then now() - interval '1 day' else now() + interval '30 days' end
      from (select x.telefono, x.nombre, x.servicio, x.proveedor, x.ventana, x.estado,
                   array(select jsonb_array_elements_text(x.desde)::int) as desde, array(select jsonb_array_elements_text(x.hasta)::int) as hasta
            from jsonb_to_recordset(neg->'espera') as x(telefono text, nombre text, servicio text, proveedor text, desde jsonb, hasta jsonb, ventana text, estado text)) w
      join citas.services s on s.organization_id = v_org and s.name = w.servicio
      left join citas.providers p on p.organization_id = v_org and p.display_name = w.proveedor
      where not exists (select 1 from citas.appointment_waitlist q where q.organization_id = v_org and q.customer_phone = w.telefono);
  end loop;
end
$seed_fn$;
create or replace function public.seed_citas_demo_fecha_base() returns void language plpgsql as $seed_fn$
declare
  v jsonb := $citas${"seedVersion":"citas-demo-1","negocios":[{"slug":"clinica-dental-sonrisa-demo","nombre":"Clínica Dental Sonrisa (demo)","rubro":"dental","timezone":"America/Merida","sucursal":"Sucursal Centro (demo)","servicios":[{"nombre":"Limpieza dental","minutos":45,"precioCentavos":60000},{"nombre":"Consulta de valoración","minutos":30,"precioCentavos":40000},{"nombre":"Resina o empaste","minutos":60,"precioCentavos":120000},{"nombre":"Blanqueamiento","minutos":90,"precioCentavos":350000}],"proveedores":[{"nombre":"Dra. Ana Lozano","rol":"Odontóloga general","servicios":["Limpieza dental","Consulta de valoración","Resina o empaste"],"reglas":[{"dow":1,"inicio":"09:00","fin":"14:00"},{"dow":1,"inicio":"16:00","fin":"19:00"},{"dow":2,"inicio":"09:00","fin":"14:00"},{"dow":2,"inicio":"16:00","fin":"19:00"},{"dow":3,"inicio":"09:00","fin":"14:00"},{"dow":3,"inicio":"16:00","fin":"19:00"},{"dow":4,"inicio":"09:00","fin":"14:00"},{"dow":4,"inicio":"16:00","fin":"19:00"},{"dow":5,"inicio":"09:00","fin":"14:00"},{"dow":5,"inicio":"16:00","fin":"19:00"}]},{"nombre":"Dr. Luis Pech","rol":"Endodoncista","servicios":["Limpieza dental","Consulta de valoración","Resina o empaste"],"reglas":[{"dow":2,"inicio":"10:00","fin":"18:00"},{"dow":3,"inicio":"10:00","fin":"18:00"},{"dow":4,"inicio":"10:00","fin":"18:00"},{"dow":5,"inicio":"10:00","fin":"18:00"},{"dow":6,"inicio":"10:00","fin":"18:00"}]},{"nombre":"Dra. Marisol Canché","rol":"Higienista","servicios":["Limpieza dental","Blanqueamiento"],"reglas":[{"dow":1,"inicio":"09:00","fin":"15:00"},{"dow":3,"inicio":"09:00","fin":"15:00"},{"dow":5,"inicio":"09:00","fin":"15:00"}]}],"excepciones":[{"proveedor":"Dra. Ana Lozano","semana":1,"dow":3,"cerrado":true,"inicio":null,"fin":null,"motivo":"Capacitación (demo)"},{"proveedor":"Dr. Luis Pech","semana":2,"dow":6,"cerrado":false,"inicio":"10:00","fin":"14:00","motivo":"Medio día (demo)"},{"proveedor":"Dra. Marisol Canché","semana":1,"dow":1,"cerrado":true,"inicio":null,"fin":null,"motivo":"Día inhábil (demo)"}],"clientes":[{"nombre":"Sofía Canul Ek","telefono":"5200101000","email":"sofia.canul@example.test"},{"nombre":"Marco Uc Pech","telefono":"5200101001","email":"marco.uc@example.test"},{"nombre":"Lucía Pech Dzul","telefono":"5200101002","email":"lucia.pech@example.test"},{"nombre":"Iván Cen Tun","telefono":"5200101003","email":"ivan.cen@example.test"},{"nombre":"Paola Chan Kú","telefono":"5200101004","email":"paola.chan@example.test"},{"nombre":"Elena Dzul Cab","telefono":"5200101005","email":"elena.dzul@example.test"},{"nombre":"Tomás Kú Moo","telefono":"5200101006","email":"tomas.ku@example.test"},{"nombre":"Carmen Euán Aké","telefono":"5200101007","email":"carmen.euan@example.test"},{"nombre":"Hugo Ay Tzec","telefono":"5200101008","email":"hugo.ay@example.test"},{"nombre":"Fabiola Ku Cauich","telefono":"5200101009","email":"fabiola.ku@example.test"}],"citas":[{"clave":"d01","idempotencyKey":"c3c2c776ab7f154de0c685fcaff9ef9024a11168a9d0bd3838568dcb25a7df94","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101000","semana":-3,"dow":1,"hora":"09:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"d02","idempotencyKey":"91f1edeac5edaa76cd8794a508d0c768e94bb6a71bdf28b0e3e1713df83fb718","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101001","semana":-3,"dow":2,"hora":"10:00","estado":"completed","origen":"voice","notas":null},{"clave":"d03","idempotencyKey":"b93263a8ca66c41b9479bde660dbe5bea60beb3dc3c73b31c8bc08c053d5ad61","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101002","semana":-3,"dow":3,"hora":"11:00","estado":"completed","origen":"manual","notas":"Molar superior derecho"},{"clave":"d04","idempotencyKey":"b28ca984305d98b5cc43924ec94374d6a39a0c2ce4b01d4d063d80359bcbb2f5","proveedor":"Dra. Marisol Canché","servicio":"Blanqueamiento","telefono":"5200101003","semana":-3,"dow":3,"hora":"09:30","estado":"completed","origen":"web","notas":null},{"clave":"d05","idempotencyKey":"38cd410a899a4b5c1ec7633e81ea42ab633713bb7ec32a57e263041dbfc56aa8","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101004","semana":-3,"dow":4,"hora":"16:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"d06","idempotencyKey":"e96fee2a3934245a4e46d03744c545ce5123a19ceb82f212af83628254d22af7","proveedor":"Dr. Luis Pech","servicio":"Consulta de valoración","telefono":"5200101005","semana":-2,"dow":2,"hora":"12:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"d07","idempotencyKey":"53295a4367e3b7893b0c78db9ae009f45603e88ed53cff7eb47b44d17fdaf86f","proveedor":"Dra. Marisol Canché","servicio":"Limpieza dental","telefono":"5200101006","semana":-2,"dow":1,"hora":"10:00","estado":"completed","origen":"web","notas":null},{"clave":"d08","idempotencyKey":"be2bbb16dd5280dc82fca4f01724ab111c1dfdacf3a45f22c5af0494de78ade2","proveedor":"Dra. Ana Lozano","servicio":"Resina o empaste","telefono":"5200101000","semana":-2,"dow":5,"hora":"17:00","estado":"completed","origen":"manual","notas":null},{"clave":"d09","idempotencyKey":"c41090339ead4ec92fc74360cd5e141dedc0d494e545a3f7f290bedc020b69bc","proveedor":"Dr. Luis Pech","servicio":"Limpieza dental","telefono":"5200101007","semana":-2,"dow":6,"hora":"10:30","estado":"no_show","origen":"voice","notas":null},{"clave":"d10","idempotencyKey":"6c30e5634be60467a3b18cdd5a996b3e660a40843779f055cde3d043ab29044d","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101008","semana":-2,"dow":3,"hora":"09:00","estado":"cancelled","origen":"whatsapp","notas":"Avisó que tenía junta"},{"clave":"d11","idempotencyKey":"76e90ff23c655ed0de9ab30993fa023c8cfebaf4914ee56a78e7986fc8fd8a0b","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101001","semana":-1,"dow":1,"hora":"09:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"d12","idempotencyKey":"e54ae2fbea0e0577f6abd7e9559c1ac258cb70341b5d9c8ced8756a6ad865507","proveedor":"Dra. Marisol Canché","servicio":"Blanqueamiento","telefono":"5200101009","semana":-1,"dow":5,"hora":"09:00","estado":"completed","origen":"web","notas":null},{"clave":"d13","idempotencyKey":"778513984390c817595952b2c45894265ca2775db558db403e8f7feb19020b9c","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101003","semana":-1,"dow":4,"hora":"14:00","estado":"completed","origen":"voice","notas":null},{"clave":"d14","idempotencyKey":"ec1c63b04f07b2a986c4b772e2f1c922fda2fedf8c9addc1c7c3bed6d99e9ad1","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101002","semana":-1,"dow":2,"hora":"16:30","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"d15","idempotencyKey":"e543e22896393abd970ea5f902f4014b524b626fff2845339784735a85ea630b","proveedor":"Dr. Luis Pech","servicio":"Consulta de valoración","telefono":"5200101004","semana":-1,"dow":3,"hora":"10:00","estado":"cancelled","origen":"web","notas":null},{"clave":"d16","idempotencyKey":"a5787693018708c8fb423587529ada21a838f988d8cca8c6bd7784148c6e00ee","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101005","semana":1,"dow":1,"hora":"09:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"d17","idempotencyKey":"3bcc7e91d8b921728b48a3e2bdb663e8c94e426c63750b3430afe730e79ad182","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101006","semana":1,"dow":2,"hora":"11:00","estado":"confirmed","origen":"manual","notas":null},{"clave":"d18","idempotencyKey":"e191073577847f1e1c995aa312418f3af380e1127cb2a8708068f9478dce1da4","proveedor":"Dra. Marisol Canché","servicio":"Limpieza dental","telefono":"5200101007","semana":1,"dow":3,"hora":"10:00","estado":"pending","origen":"web","notas":null},{"clave":"d19","idempotencyKey":"68811ff82e8825137fb9da6dc9d9f7b7a1ec134dd5324624435fbdb0d1f59011","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101000","semana":1,"dow":4,"hora":"17:00","estado":"pending","origen":"whatsapp","notas":null},{"clave":"d20","idempotencyKey":"cf26eb5d80937cf6bdb28501f22944fec1bf8b3f404d6170a57dcfb6a026b482","proveedor":"Dr. Luis Pech","servicio":"Consulta de valoración","telefono":"5200101008","semana":1,"dow":5,"hora":"15:00","estado":"confirmed","origen":"voice","notas":null},{"clave":"d21","idempotencyKey":"febc71339aaf4f902db907134101d72b7c5edac6a4e5f85044f3756817a71747","proveedor":"Dra. Marisol Canché","servicio":"Blanqueamiento","telefono":"5200101009","semana":1,"dow":5,"hora":"11:00","estado":"cancelled","origen":"web","notas":null},{"clave":"d22","idempotencyKey":"e184151fb7a86b2eaab47b39735ae3208c869161e9b522ea64b7b98b5de8ed87","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101001","semana":2,"dow":2,"hora":"10:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"d23","idempotencyKey":"8e0a4efb5f21f7a9661cdcb695a152f3609f8655ed675a9e7c5c791b251f151a","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101002","semana":2,"dow":6,"hora":"13:00","estado":"pending","origen":"manual","notas":null},{"clave":"d24","idempotencyKey":"bda11e025f55d7eb6160cba97f3ed9d6ffc398d6cfb0f1e0a24cdb145c4969ed","proveedor":"Dra. Marisol Canché","servicio":"Limpieza dental","telefono":"5200101003","semana":2,"dow":1,"hora":"09:00","estado":"confirmed","origen":"web","notas":null},{"clave":"d25","idempotencyKey":"3a8b2ffccca229c9490030e370935769d9c3507a3d803c1e00f76c7196fa096f","proveedor":"Dra. Ana Lozano","servicio":"Resina o empaste","telefono":"5200101004","semana":2,"dow":4,"hora":"09:00","estado":"confirmed","origen":"whatsapp","notas":null}],"espera":[{"telefono":"5200101050","nombre":"Andrea Pat Mex","servicio":"Limpieza dental","proveedor":"Dra. Ana Lozano","desde":[1,1],"hasta":[1,5],"ventana":"morning","estado":"active"},{"telefono":"5200101051","nombre":"Raúl Cupul Ix","servicio":"Consulta de valoración","proveedor":null,"desde":[1,1],"hasta":[2,5],"ventana":"any","estado":"notified"},{"telefono":"5200101052","nombre":"Diana Balam Hau","servicio":"Resina o empaste","proveedor":"Dr. Luis Pech","desde":[-1,1],"hasta":[-1,5],"ventana":"afternoon","estado":"fulfilled"},{"telefono":"5200101053","nombre":"Víctor Ek Naal","servicio":"Blanqueamiento","proveedor":"Dra. Marisol Canché","desde":[1,1],"hasta":[2,5],"ventana":"any","estado":"cancelled"},{"telefono":"5200101054","nombre":"Mireya Tuz Xool","servicio":"Limpieza dental","proveedor":null,"desde":[-3,1],"hasta":[-3,5],"ventana":"evening","estado":"expired"}]},{"slug":"barberia-el-filo-demo","nombre":"Barbería El Filo (demo)","rubro":"barberia","timezone":"America/Merida","sucursal":"Sucursal Norte (demo)","servicios":[{"nombre":"Corte de cabello","minutos":30,"precioCentavos":25000},{"nombre":"Arreglo de barba","minutos":20,"precioCentavos":15000},{"nombre":"Corte y barba","minutos":45,"precioCentavos":35000},{"nombre":"Afeitado clásico","minutos":30,"precioCentavos":20000}],"proveedores":[{"nombre":"Beto","rol":"Barbero","servicios":["Corte de cabello","Arreglo de barba","Corte y barba","Afeitado clásico"],"reglas":[{"dow":2,"inicio":"10:00","fin":"20:00"},{"dow":3,"inicio":"10:00","fin":"20:00"},{"dow":4,"inicio":"10:00","fin":"20:00"},{"dow":5,"inicio":"10:00","fin":"20:00"},{"dow":6,"inicio":"10:00","fin":"20:00"}]},{"nombre":"Chuy","rol":"Barbero","servicios":["Corte de cabello","Arreglo de barba","Corte y barba"],"reglas":[{"dow":1,"inicio":"11:00","fin":"19:00"},{"dow":2,"inicio":"11:00","fin":"19:00"},{"dow":3,"inicio":"11:00","fin":"19:00"},{"dow":4,"inicio":"11:00","fin":"19:00"},{"dow":5,"inicio":"11:00","fin":"19:00"}]},{"nombre":"Memo","rol":"Barbero","servicios":["Corte de cabello","Afeitado clásico"],"reglas":[{"dow":4,"inicio":"12:00","fin":"21:00"},{"dow":5,"inicio":"12:00","fin":"21:00"},{"dow":6,"inicio":"12:00","fin":"21:00"}]}],"excepciones":[{"proveedor":"Beto","semana":1,"dow":5,"cerrado":true,"inicio":null,"fin":null,"motivo":"Descanso (demo)"},{"proveedor":"Chuy","semana":2,"dow":5,"cerrado":false,"inicio":"11:00","fin":"15:00","motivo":"Salida temprano (demo)"}],"clientes":[{"nombre":"Daniel Tun May","telefono":"5200201000","email":"daniel.tun@example.test"},{"nombre":"Rodrigo Pool Be","telefono":"5200201001","email":"rodrigo.pool@example.test"},{"nombre":"Erick Moo Cob","telefono":"5200201002","email":"erick.moo@example.test"},{"nombre":"Pedro Tzec Ake","telefono":"5200201003","email":"pedro.tzec@example.test"},{"nombre":"Memo Aké Dzib","telefono":"5200201004","email":"memo.ake@example.test"},{"nombre":"Sergio Mex Poot","telefono":"5200201005","email":"sergio.mex@example.test"},{"nombre":"Luis Ake Chi","telefono":"5200201006","email":"luis.ake@example.test"},{"nombre":"Iker Dzul Uc","telefono":"5200201007","email":"iker.dzul@example.test"},{"nombre":"Beto Sosa Cetz","telefono":"5200201008","email":"beto.sosa@example.test"},{"nombre":"Julio Cab Yam","telefono":"5200201009","email":"julio.cab@example.test"}],"citas":[{"clave":"b01","idempotencyKey":"d1dd3298683efc6578020679f9b01c6ea9b54849dd32a954312129b4ab73d537","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201000","semana":-3,"dow":2,"hora":"10:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b02","idempotencyKey":"6b334e9ab08c7ab0c5c736a7a6d72e6d9aae863b054a3ad99d18892f0ccfb79b","proveedor":"Chuy","servicio":"Corte y barba","telefono":"5200201001","semana":-3,"dow":1,"hora":"11:00","estado":"completed","origen":"web","notas":null},{"clave":"b03","idempotencyKey":"7f00f7b1ea8135381d606e441bbfbb9dd28455a4a003ddb192f1911555aa3ec3","proveedor":"Memo","servicio":"Afeitado clásico","telefono":"5200201002","semana":-3,"dow":4,"hora":"12:00","estado":"completed","origen":"manual","notas":null},{"clave":"b04","idempotencyKey":"7f432d4304ff37e861eb9491daa1014042e1dcb515d36fe518c45fd08defe316","proveedor":"Beto","servicio":"Arreglo de barba","telefono":"5200201003","semana":-3,"dow":6,"hora":"15:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"b05","idempotencyKey":"5ec9e9d55b522068f5e2133245781447044b3682de888d64dfcc0242cc38fc76","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201004","semana":-3,"dow":3,"hora":"17:00","estado":"completed","origen":"voice","notas":null},{"clave":"b06","idempotencyKey":"23165ee18227706d774e4658682cad4935d6af0ad8ab07cc43e55ec3134aab22","proveedor":"Beto","servicio":"Corte y barba","telefono":"5200201005","semana":-2,"dow":2,"hora":"18:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b07","idempotencyKey":"9b5251ecd9c89580736c747c166af1ed153f755baa7cc954c10d9683f2677d2f","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201006","semana":-2,"dow":5,"hora":"11:30","estado":"completed","origen":"web","notas":null},{"clave":"b08","idempotencyKey":"88c5e413cd5312d0e8b6e60fd994f87e472223862a296e955632e73ebe377bd8","proveedor":"Memo","servicio":"Corte de cabello","telefono":"5200201007","semana":-2,"dow":6,"hora":"19:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b09","idempotencyKey":"441851fc1fc767b7c323fc2f4c836022a479c571cd320688fdaf1d65c45cf133","proveedor":"Beto","servicio":"Afeitado clásico","telefono":"5200201000","semana":-2,"dow":4,"hora":"10:30","estado":"cancelled","origen":"manual","notas":"Pidió cambiar de día"},{"clave":"b10","idempotencyKey":"5d97fb52775e47cdf2aa3c03ecb3101da21dadbe6f857d8f75e974ed6b646c4e","proveedor":"Chuy","servicio":"Arreglo de barba","telefono":"5200201008","semana":-2,"dow":1,"hora":"15:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"b11","idempotencyKey":"c469d63792ce4f8be979ae232812bb94342b77754674cd406c45d5d35761b744","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201001","semana":-1,"dow":3,"hora":"10:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b12","idempotencyKey":"d511de1ce852164ccabda421da6c06a6942cbc71011ae18dda5c654e37e1b507","proveedor":"Chuy","servicio":"Corte y barba","telefono":"5200201009","semana":-1,"dow":2,"hora":"13:00","estado":"completed","origen":"web","notas":null},{"clave":"b13","idempotencyKey":"e4d37831810563f99d734e29793744844ebcc3cf4f2aa519434f6d82f7d7b54f","proveedor":"Memo","servicio":"Corte de cabello","telefono":"5200201002","semana":-1,"dow":4,"hora":"12:30","estado":"completed","origen":"voice","notas":null},{"clave":"b14","idempotencyKey":"f1de19db5ebafb4b3aabac5c4606bf27c42cef16230982ae7656a880a4fe014a","proveedor":"Beto","servicio":"Corte y barba","telefono":"5200201003","semana":-1,"dow":5,"hora":"16:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"b15","idempotencyKey":"15fe586adc2db5a6454285e1c4d7757c2ccfc81acc3b408474b63f906a1311e7","proveedor":"Chuy","servicio":"Arreglo de barba","telefono":"5200201004","semana":-1,"dow":4,"hora":"18:00","estado":"cancelled","origen":"web","notas":null},{"clave":"b16","idempotencyKey":"2db1e4ea3c0058432a1bdf9295f82af3871b6ca1aa0a6433b3d683bd9fff80e3","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201005","semana":1,"dow":2,"hora":"10:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"b17","idempotencyKey":"e8badc02d5fdd3288aa998a32ce29684bf5fd46cbbe8d1a4cbd0610682564026","proveedor":"Chuy","servicio":"Corte y barba","telefono":"5200201006","semana":1,"dow":3,"hora":"14:00","estado":"confirmed","origen":"web","notas":null},{"clave":"b18","idempotencyKey":"e18377b9d36e5fb3fb559ea22d68dcea0505a4d8b6b4629e4286e47b670b75a1","proveedor":"Memo","servicio":"Corte de cabello","telefono":"5200201007","semana":1,"dow":4,"hora":"13:00","estado":"pending","origen":"whatsapp","notas":null},{"clave":"b19","idempotencyKey":"fe8cbf2230e1f943ae1a88e366d450c21a6885eda59494a44771707e2e0fcbda","proveedor":"Beto","servicio":"Arreglo de barba","telefono":"5200201008","semana":1,"dow":6,"hora":"12:00","estado":"pending","origen":"voice","notas":null},{"clave":"b20","idempotencyKey":"92448768828e928a8c7a499a42cb8dc0f62d96a4f5f859aedb13c9ec98e47b5b","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201009","semana":1,"dow":1,"hora":"11:00","estado":"cancelled","origen":"manual","notas":null},{"clave":"b21","idempotencyKey":"a6545235841c082ab4ee09bf4ea34a0c738fa1efd08dcd55ca1f7733b9eb4992","proveedor":"Beto","servicio":"Corte y barba","telefono":"5200201000","semana":2,"dow":2,"hora":"17:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"b22","idempotencyKey":"f3cbbffe8b1a7df13f530983c3e3d62a68a34df8497884144c39ee018a93161b","proveedor":"Memo","servicio":"Afeitado clásico","telefono":"5200201001","semana":2,"dow":5,"hora":"19:30","estado":"confirmed","origen":"web","notas":null},{"clave":"b23","idempotencyKey":"67203ea92f972e185f5cb24ff5ad7ab3f929bf65159b824b1a797e5d10ccaf46","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201002","semana":2,"dow":3,"hora":"11:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"b24","idempotencyKey":"08500a861340521456f57ed64f9bc4d72ca40735b1983c1c3ba3357707d40d84","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201003","semana":2,"dow":6,"hora":"10:00","estado":"pending","origen":"manual","notas":null}],"espera":[{"telefono":"5200201050","nombre":"Ramón Che Pat","servicio":"Corte de cabello","proveedor":"Beto","desde":[1,2],"hasta":[1,6],"ventana":"afternoon","estado":"active"},{"telefono":"5200201051","nombre":"Gael Puc Nah","servicio":"Corte y barba","proveedor":null,"desde":[1,2],"hasta":[2,6],"ventana":"any","estado":"notified"},{"telefono":"5200201052","nombre":"Ismael Ucán Kú","servicio":"Afeitado clásico","proveedor":"Memo","desde":[-1,4],"hasta":[-1,6],"ventana":"evening","estado":"fulfilled"},{"telefono":"5200201053","nombre":"Octavio Mis Tun","servicio":"Arreglo de barba","proveedor":"Chuy","desde":[1,1],"hasta":[2,5],"ventana":"morning","estado":"cancelled"},{"telefono":"5200201054","nombre":"Néstor Cen Aké","servicio":"Corte de cabello","proveedor":null,"desde":[-3,1],"hasta":[-3,6],"ventana":"any","estado":"expired"}]}]}$citas$::jsonb;
  neg jsonb;
  v_org uuid;
  v_vertical text;
  v_marcada boolean;
  v_prop uuid;
  v_user uuid;
  v_tz text;
  v_lunes date;
  v_base date := '2026-03-04'::date;
begin
  select id into v_user from core.staff_user where lower(email) = 'owner-demo@example.test';
  if v_user is null then
    raise exception 'seed-citas: no existe un usuario de staff con el correo indicado (--owner-email); el seed no crea credenciales.';
  end if;

  for neg in select * from jsonb_array_elements(v->'negocios') loop
    v_tz := neg->>'timezone';
    v_lunes := date_trunc('week', coalesce(v_base, (now() at time zone v_tz)::date)::timestamp)::date;

    -- 1) organizacion: solo se crea o se actualiza una cuenta DEMO de citas; cualquier otra con ese slug aborta.
    select id, vertical into v_org, v_vertical from core.organization where slug = neg->>'slug';
    if v_org is not null then
      select exists (select 1 from citas.demo_organization d where d.organization_id = v_org) into v_marcada;
      if v_vertical <> 'citas' or not v_marcada then
        raise exception 'seed-citas: el slug % ya existe y no es una cuenta demo de citas; no se toca.', neg->>'slug';
      end if;
      update core.organization set name = neg->>'nombre' where id = v_org;
    else
      insert into core.organization (vertical, name, slug) values ('citas', neg->>'nombre', neg->>'slug') returning id into v_org;
    end if;
    insert into citas.demo_organization (organization_id, seed_version) values (v_org, v->>'seedVersion')
      on conflict (organization_id) do update set seed_version = excluded.seed_version;

    insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
      values (v_user, v_org, null, 'owner', 'owner')
      on conflict do nothing;

    -- 2) sucursal, configuracion y zona horaria
    select id into v_prop from core.property where organization_id = v_org and name = neg->>'sucursal';
    if v_prop is null then
      insert into core.property (organization_id, vertical, name, status) values (v_org, 'citas', neg->>'sucursal', 'active') returning id into v_prop;
    end if;
    insert into citas.tenant_config (organization_id, rubro, default_timezone) values (v_org, neg->>'rubro', v_tz)
      on conflict (organization_id) do update set rubro = excluded.rubro, default_timezone = excluded.default_timezone, updated_at = now();
    insert into citas.property_config (property_id, organization_id, timezone) values (v_prop, v_org, v_tz)
      on conflict (property_id) do update set timezone = excluded.timezone;

    -- 3) servicios (por nombre)
    update citas.services s set duration_minutes = x.minutos, price_cents = x."precioCentavos", is_active = true, updated_at = now()
      from jsonb_to_recordset(neg->'servicios') as x(nombre text, minutos int, "precioCentavos" int)
      where s.organization_id = v_org and s.name = x.nombre;
    insert into citas.services (organization_id, name, duration_minutes, price_cents)
      select v_org, x.nombre, x.minutos, x."precioCentavos"
      from jsonb_to_recordset(neg->'servicios') as x(nombre text, minutos int, "precioCentavos" int)
      where not exists (select 1 from citas.services s where s.organization_id = v_org and s.name = x.nombre);

    -- 4) proveedores (por nombre) y los servicios que ofrece cada uno
    update citas.providers p set role_label = x.rol, property_id = v_prop, is_active = true, updated_at = now()
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, rol text)
      where p.organization_id = v_org and p.display_name = x.nombre;
    insert into citas.providers (organization_id, property_id, display_name, role_label)
      select v_org, v_prop, x.nombre, x.rol
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, rol text)
      where not exists (select 1 from citas.providers p where p.organization_id = v_org and p.display_name = x.nombre);
    insert into citas.provider_services (provider_id, service_id)
      select p.id, s.id
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, servicios jsonb)
      join citas.providers p on p.organization_id = v_org and p.display_name = x.nombre
      cross join lateral jsonb_array_elements_text(x.servicios) as sn(nombre)
      join citas.services s on s.organization_id = v_org and s.name = sn.nombre
      on conflict do nothing;

    -- 5) horario semanal (se reescribe: solo existe en esta organizacion demo) y excepciones
    delete from citas.availability_rules r using citas.providers p
      where r.provider_id = p.id and p.organization_id = v_org;
    insert into citas.availability_rules (provider_id, day_of_week, start_time, end_time)
      select p.id, r.dow, r.inicio::time, r.fin::time
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, reglas jsonb)
      join citas.providers p on p.organization_id = v_org and p.display_name = x.nombre
      cross join lateral jsonb_to_recordset(x.reglas) as r(dow int, inicio text, fin text);
    insert into citas.availability_overrides (provider_id, override_date, is_closed, start_time, end_time, reason)
      select p.id, v_lunes + (e.semana * 7) + (case when e.dow = 0 then 6 else e.dow - 1 end), e.cerrado, e.inicio::time, e.fin::time, e.motivo
      from jsonb_to_recordset(neg->'excepciones') as e(proveedor text, semana int, dow int, cerrado boolean, inicio text, fin text, motivo text)
      join citas.providers p on p.organization_id = v_org and p.display_name = e.proveedor
      on conflict (provider_id, override_date) do update set is_closed = excluded.is_closed, start_time = excluded.start_time,
        end_time = excluded.end_time, reason = excluded.reason;

    -- 6) clientes ficticios (por organizacion + telefono)
    insert into citas.customers (organization_id, full_name, phone, email)
      select v_org, c.nombre, c.telefono, c.email
      from jsonb_to_recordset(neg->'clientes') as c(nombre text, telefono text, email text)
      on conflict (organization_id, phone) do update set full_name = excluded.full_name, email = excluded.email, updated_at = now();

    -- 7) citas: llave de idempotencia determinista; re-ejecutar no duplica ni mueve las ya sembradas
    insert into citas.appointments (organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, notes, idempotency_key, reminder_24h_sent_at)
      select v_org, v_prop, p.id, s.id, cu.id, st.t, st.t + make_interval(mins => s.duration_minutes), a.estado, a.origen, a.notas, a."idempotencyKey",
             case when a.semana < 0 and a.estado in ('completed', 'no_show') then st.t - interval '24 hours' else null end
      from jsonb_to_recordset(neg->'citas') as a(clave text, "idempotencyKey" text, proveedor text, servicio text, telefono text, semana int, dow int, hora text, estado text, origen text, notas text)
      join citas.providers p on p.organization_id = v_org and p.display_name = a.proveedor
      join citas.services s on s.organization_id = v_org and s.name = a.servicio
      join citas.customers cu on cu.organization_id = v_org and cu.phone = a.telefono
      cross join lateral (select ((v_lunes + (a.semana * 7) + (case when a.dow = 0 then 6 else a.dow - 1 end)) + a.hora::time) at time zone v_tz as t) st
      on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing;

    -- 8) lista de espera (por organizacion + telefono ficticio)
    insert into citas.appointment_waitlist (organization_id, customer_phone, customer_name, service_id, provider_id, preferred_date_from, preferred_date_to,
                                            preferred_time_window, status, notified_count, last_notified_at, expires_at)
      select v_org, w.telefono, w.nombre, s.id, p.id,
             v_lunes + (w.desde[1] * 7) + (case when w.desde[2] = 0 then 6 else w.desde[2] - 1 end),
             v_lunes + (w.hasta[1] * 7) + (case when w.hasta[2] = 0 then 6 else w.hasta[2] - 1 end),
             w.ventana, w.estado,
             case when w.estado in ('notified', 'fulfilled') then 1 else 0 end,
             case when w.estado in ('notified', 'fulfilled') then now() - interval '1 day' else null end,
             case when w.estado = 'expired' then now() - interval '1 day' else now() + interval '30 days' end
      from (select x.telefono, x.nombre, x.servicio, x.proveedor, x.ventana, x.estado,
                   array(select jsonb_array_elements_text(x.desde)::int) as desde, array(select jsonb_array_elements_text(x.hasta)::int) as hasta
            from jsonb_to_recordset(neg->'espera') as x(telefono text, nombre text, servicio text, proveedor text, desde jsonb, hasta jsonb, ventana text, estado text)) w
      join citas.services s on s.organization_id = v_org and s.name = w.servicio
      left join citas.providers p on p.organization_id = v_org and p.display_name = w.proveedor
      where not exists (select 1 from citas.appointment_waitlist q where q.organization_id = v_org and q.customer_phone = w.telefono);
  end loop;
end
$seed_fn$;
create or replace function public.seed_citas_demo_sin_owner() returns void language plpgsql as $seed_fn$
declare
  v jsonb := $citas${"seedVersion":"citas-demo-1","negocios":[{"slug":"clinica-dental-sonrisa-demo","nombre":"Clínica Dental Sonrisa (demo)","rubro":"dental","timezone":"America/Merida","sucursal":"Sucursal Centro (demo)","servicios":[{"nombre":"Limpieza dental","minutos":45,"precioCentavos":60000},{"nombre":"Consulta de valoración","minutos":30,"precioCentavos":40000},{"nombre":"Resina o empaste","minutos":60,"precioCentavos":120000},{"nombre":"Blanqueamiento","minutos":90,"precioCentavos":350000}],"proveedores":[{"nombre":"Dra. Ana Lozano","rol":"Odontóloga general","servicios":["Limpieza dental","Consulta de valoración","Resina o empaste"],"reglas":[{"dow":1,"inicio":"09:00","fin":"14:00"},{"dow":1,"inicio":"16:00","fin":"19:00"},{"dow":2,"inicio":"09:00","fin":"14:00"},{"dow":2,"inicio":"16:00","fin":"19:00"},{"dow":3,"inicio":"09:00","fin":"14:00"},{"dow":3,"inicio":"16:00","fin":"19:00"},{"dow":4,"inicio":"09:00","fin":"14:00"},{"dow":4,"inicio":"16:00","fin":"19:00"},{"dow":5,"inicio":"09:00","fin":"14:00"},{"dow":5,"inicio":"16:00","fin":"19:00"}]},{"nombre":"Dr. Luis Pech","rol":"Endodoncista","servicios":["Limpieza dental","Consulta de valoración","Resina o empaste"],"reglas":[{"dow":2,"inicio":"10:00","fin":"18:00"},{"dow":3,"inicio":"10:00","fin":"18:00"},{"dow":4,"inicio":"10:00","fin":"18:00"},{"dow":5,"inicio":"10:00","fin":"18:00"},{"dow":6,"inicio":"10:00","fin":"18:00"}]},{"nombre":"Dra. Marisol Canché","rol":"Higienista","servicios":["Limpieza dental","Blanqueamiento"],"reglas":[{"dow":1,"inicio":"09:00","fin":"15:00"},{"dow":3,"inicio":"09:00","fin":"15:00"},{"dow":5,"inicio":"09:00","fin":"15:00"}]}],"excepciones":[{"proveedor":"Dra. Ana Lozano","semana":1,"dow":3,"cerrado":true,"inicio":null,"fin":null,"motivo":"Capacitación (demo)"},{"proveedor":"Dr. Luis Pech","semana":2,"dow":6,"cerrado":false,"inicio":"10:00","fin":"14:00","motivo":"Medio día (demo)"},{"proveedor":"Dra. Marisol Canché","semana":1,"dow":1,"cerrado":true,"inicio":null,"fin":null,"motivo":"Día inhábil (demo)"}],"clientes":[{"nombre":"Sofía Canul Ek","telefono":"5200101000","email":"sofia.canul@example.test"},{"nombre":"Marco Uc Pech","telefono":"5200101001","email":"marco.uc@example.test"},{"nombre":"Lucía Pech Dzul","telefono":"5200101002","email":"lucia.pech@example.test"},{"nombre":"Iván Cen Tun","telefono":"5200101003","email":"ivan.cen@example.test"},{"nombre":"Paola Chan Kú","telefono":"5200101004","email":"paola.chan@example.test"},{"nombre":"Elena Dzul Cab","telefono":"5200101005","email":"elena.dzul@example.test"},{"nombre":"Tomás Kú Moo","telefono":"5200101006","email":"tomas.ku@example.test"},{"nombre":"Carmen Euán Aké","telefono":"5200101007","email":"carmen.euan@example.test"},{"nombre":"Hugo Ay Tzec","telefono":"5200101008","email":"hugo.ay@example.test"},{"nombre":"Fabiola Ku Cauich","telefono":"5200101009","email":"fabiola.ku@example.test"}],"citas":[{"clave":"d01","idempotencyKey":"c3c2c776ab7f154de0c685fcaff9ef9024a11168a9d0bd3838568dcb25a7df94","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101000","semana":-3,"dow":1,"hora":"09:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"d02","idempotencyKey":"91f1edeac5edaa76cd8794a508d0c768e94bb6a71bdf28b0e3e1713df83fb718","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101001","semana":-3,"dow":2,"hora":"10:00","estado":"completed","origen":"voice","notas":null},{"clave":"d03","idempotencyKey":"b93263a8ca66c41b9479bde660dbe5bea60beb3dc3c73b31c8bc08c053d5ad61","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101002","semana":-3,"dow":3,"hora":"11:00","estado":"completed","origen":"manual","notas":"Molar superior derecho"},{"clave":"d04","idempotencyKey":"b28ca984305d98b5cc43924ec94374d6a39a0c2ce4b01d4d063d80359bcbb2f5","proveedor":"Dra. Marisol Canché","servicio":"Blanqueamiento","telefono":"5200101003","semana":-3,"dow":3,"hora":"09:30","estado":"completed","origen":"web","notas":null},{"clave":"d05","idempotencyKey":"38cd410a899a4b5c1ec7633e81ea42ab633713bb7ec32a57e263041dbfc56aa8","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101004","semana":-3,"dow":4,"hora":"16:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"d06","idempotencyKey":"e96fee2a3934245a4e46d03744c545ce5123a19ceb82f212af83628254d22af7","proveedor":"Dr. Luis Pech","servicio":"Consulta de valoración","telefono":"5200101005","semana":-2,"dow":2,"hora":"12:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"d07","idempotencyKey":"53295a4367e3b7893b0c78db9ae009f45603e88ed53cff7eb47b44d17fdaf86f","proveedor":"Dra. Marisol Canché","servicio":"Limpieza dental","telefono":"5200101006","semana":-2,"dow":1,"hora":"10:00","estado":"completed","origen":"web","notas":null},{"clave":"d08","idempotencyKey":"be2bbb16dd5280dc82fca4f01724ab111c1dfdacf3a45f22c5af0494de78ade2","proveedor":"Dra. Ana Lozano","servicio":"Resina o empaste","telefono":"5200101000","semana":-2,"dow":5,"hora":"17:00","estado":"completed","origen":"manual","notas":null},{"clave":"d09","idempotencyKey":"c41090339ead4ec92fc74360cd5e141dedc0d494e545a3f7f290bedc020b69bc","proveedor":"Dr. Luis Pech","servicio":"Limpieza dental","telefono":"5200101007","semana":-2,"dow":6,"hora":"10:30","estado":"no_show","origen":"voice","notas":null},{"clave":"d10","idempotencyKey":"6c30e5634be60467a3b18cdd5a996b3e660a40843779f055cde3d043ab29044d","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101008","semana":-2,"dow":3,"hora":"09:00","estado":"cancelled","origen":"whatsapp","notas":"Avisó que tenía junta"},{"clave":"d11","idempotencyKey":"76e90ff23c655ed0de9ab30993fa023c8cfebaf4914ee56a78e7986fc8fd8a0b","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101001","semana":-1,"dow":1,"hora":"09:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"d12","idempotencyKey":"e54ae2fbea0e0577f6abd7e9559c1ac258cb70341b5d9c8ced8756a6ad865507","proveedor":"Dra. Marisol Canché","servicio":"Blanqueamiento","telefono":"5200101009","semana":-1,"dow":5,"hora":"09:00","estado":"completed","origen":"web","notas":null},{"clave":"d13","idempotencyKey":"778513984390c817595952b2c45894265ca2775db558db403e8f7feb19020b9c","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101003","semana":-1,"dow":4,"hora":"14:00","estado":"completed","origen":"voice","notas":null},{"clave":"d14","idempotencyKey":"ec1c63b04f07b2a986c4b772e2f1c922fda2fedf8c9addc1c7c3bed6d99e9ad1","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101002","semana":-1,"dow":2,"hora":"16:30","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"d15","idempotencyKey":"e543e22896393abd970ea5f902f4014b524b626fff2845339784735a85ea630b","proveedor":"Dr. Luis Pech","servicio":"Consulta de valoración","telefono":"5200101004","semana":-1,"dow":3,"hora":"10:00","estado":"cancelled","origen":"web","notas":null},{"clave":"d16","idempotencyKey":"a5787693018708c8fb423587529ada21a838f988d8cca8c6bd7784148c6e00ee","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101005","semana":1,"dow":1,"hora":"09:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"d17","idempotencyKey":"3bcc7e91d8b921728b48a3e2bdb663e8c94e426c63750b3430afe730e79ad182","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101006","semana":1,"dow":2,"hora":"11:00","estado":"confirmed","origen":"manual","notas":null},{"clave":"d18","idempotencyKey":"e191073577847f1e1c995aa312418f3af380e1127cb2a8708068f9478dce1da4","proveedor":"Dra. Marisol Canché","servicio":"Limpieza dental","telefono":"5200101007","semana":1,"dow":3,"hora":"10:00","estado":"pending","origen":"web","notas":null},{"clave":"d19","idempotencyKey":"68811ff82e8825137fb9da6dc9d9f7b7a1ec134dd5324624435fbdb0d1f59011","proveedor":"Dra. Ana Lozano","servicio":"Consulta de valoración","telefono":"5200101000","semana":1,"dow":4,"hora":"17:00","estado":"pending","origen":"whatsapp","notas":null},{"clave":"d20","idempotencyKey":"cf26eb5d80937cf6bdb28501f22944fec1bf8b3f404d6170a57dcfb6a026b482","proveedor":"Dr. Luis Pech","servicio":"Consulta de valoración","telefono":"5200101008","semana":1,"dow":5,"hora":"15:00","estado":"confirmed","origen":"voice","notas":null},{"clave":"d21","idempotencyKey":"febc71339aaf4f902db907134101d72b7c5edac6a4e5f85044f3756817a71747","proveedor":"Dra. Marisol Canché","servicio":"Blanqueamiento","telefono":"5200101009","semana":1,"dow":5,"hora":"11:00","estado":"cancelled","origen":"web","notas":null},{"clave":"d22","idempotencyKey":"e184151fb7a86b2eaab47b39735ae3208c869161e9b522ea64b7b98b5de8ed87","proveedor":"Dra. Ana Lozano","servicio":"Limpieza dental","telefono":"5200101001","semana":2,"dow":2,"hora":"10:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"d23","idempotencyKey":"8e0a4efb5f21f7a9661cdcb695a152f3609f8655ed675a9e7c5c791b251f151a","proveedor":"Dr. Luis Pech","servicio":"Resina o empaste","telefono":"5200101002","semana":2,"dow":6,"hora":"13:00","estado":"pending","origen":"manual","notas":null},{"clave":"d24","idempotencyKey":"bda11e025f55d7eb6160cba97f3ed9d6ffc398d6cfb0f1e0a24cdb145c4969ed","proveedor":"Dra. Marisol Canché","servicio":"Limpieza dental","telefono":"5200101003","semana":2,"dow":1,"hora":"09:00","estado":"confirmed","origen":"web","notas":null},{"clave":"d25","idempotencyKey":"3a8b2ffccca229c9490030e370935769d9c3507a3d803c1e00f76c7196fa096f","proveedor":"Dra. Ana Lozano","servicio":"Resina o empaste","telefono":"5200101004","semana":2,"dow":4,"hora":"09:00","estado":"confirmed","origen":"whatsapp","notas":null}],"espera":[{"telefono":"5200101050","nombre":"Andrea Pat Mex","servicio":"Limpieza dental","proveedor":"Dra. Ana Lozano","desde":[1,1],"hasta":[1,5],"ventana":"morning","estado":"active"},{"telefono":"5200101051","nombre":"Raúl Cupul Ix","servicio":"Consulta de valoración","proveedor":null,"desde":[1,1],"hasta":[2,5],"ventana":"any","estado":"notified"},{"telefono":"5200101052","nombre":"Diana Balam Hau","servicio":"Resina o empaste","proveedor":"Dr. Luis Pech","desde":[-1,1],"hasta":[-1,5],"ventana":"afternoon","estado":"fulfilled"},{"telefono":"5200101053","nombre":"Víctor Ek Naal","servicio":"Blanqueamiento","proveedor":"Dra. Marisol Canché","desde":[1,1],"hasta":[2,5],"ventana":"any","estado":"cancelled"},{"telefono":"5200101054","nombre":"Mireya Tuz Xool","servicio":"Limpieza dental","proveedor":null,"desde":[-3,1],"hasta":[-3,5],"ventana":"evening","estado":"expired"}]},{"slug":"barberia-el-filo-demo","nombre":"Barbería El Filo (demo)","rubro":"barberia","timezone":"America/Merida","sucursal":"Sucursal Norte (demo)","servicios":[{"nombre":"Corte de cabello","minutos":30,"precioCentavos":25000},{"nombre":"Arreglo de barba","minutos":20,"precioCentavos":15000},{"nombre":"Corte y barba","minutos":45,"precioCentavos":35000},{"nombre":"Afeitado clásico","minutos":30,"precioCentavos":20000}],"proveedores":[{"nombre":"Beto","rol":"Barbero","servicios":["Corte de cabello","Arreglo de barba","Corte y barba","Afeitado clásico"],"reglas":[{"dow":2,"inicio":"10:00","fin":"20:00"},{"dow":3,"inicio":"10:00","fin":"20:00"},{"dow":4,"inicio":"10:00","fin":"20:00"},{"dow":5,"inicio":"10:00","fin":"20:00"},{"dow":6,"inicio":"10:00","fin":"20:00"}]},{"nombre":"Chuy","rol":"Barbero","servicios":["Corte de cabello","Arreglo de barba","Corte y barba"],"reglas":[{"dow":1,"inicio":"11:00","fin":"19:00"},{"dow":2,"inicio":"11:00","fin":"19:00"},{"dow":3,"inicio":"11:00","fin":"19:00"},{"dow":4,"inicio":"11:00","fin":"19:00"},{"dow":5,"inicio":"11:00","fin":"19:00"}]},{"nombre":"Memo","rol":"Barbero","servicios":["Corte de cabello","Afeitado clásico"],"reglas":[{"dow":4,"inicio":"12:00","fin":"21:00"},{"dow":5,"inicio":"12:00","fin":"21:00"},{"dow":6,"inicio":"12:00","fin":"21:00"}]}],"excepciones":[{"proveedor":"Beto","semana":1,"dow":5,"cerrado":true,"inicio":null,"fin":null,"motivo":"Descanso (demo)"},{"proveedor":"Chuy","semana":2,"dow":5,"cerrado":false,"inicio":"11:00","fin":"15:00","motivo":"Salida temprano (demo)"}],"clientes":[{"nombre":"Daniel Tun May","telefono":"5200201000","email":"daniel.tun@example.test"},{"nombre":"Rodrigo Pool Be","telefono":"5200201001","email":"rodrigo.pool@example.test"},{"nombre":"Erick Moo Cob","telefono":"5200201002","email":"erick.moo@example.test"},{"nombre":"Pedro Tzec Ake","telefono":"5200201003","email":"pedro.tzec@example.test"},{"nombre":"Memo Aké Dzib","telefono":"5200201004","email":"memo.ake@example.test"},{"nombre":"Sergio Mex Poot","telefono":"5200201005","email":"sergio.mex@example.test"},{"nombre":"Luis Ake Chi","telefono":"5200201006","email":"luis.ake@example.test"},{"nombre":"Iker Dzul Uc","telefono":"5200201007","email":"iker.dzul@example.test"},{"nombre":"Beto Sosa Cetz","telefono":"5200201008","email":"beto.sosa@example.test"},{"nombre":"Julio Cab Yam","telefono":"5200201009","email":"julio.cab@example.test"}],"citas":[{"clave":"b01","idempotencyKey":"d1dd3298683efc6578020679f9b01c6ea9b54849dd32a954312129b4ab73d537","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201000","semana":-3,"dow":2,"hora":"10:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b02","idempotencyKey":"6b334e9ab08c7ab0c5c736a7a6d72e6d9aae863b054a3ad99d18892f0ccfb79b","proveedor":"Chuy","servicio":"Corte y barba","telefono":"5200201001","semana":-3,"dow":1,"hora":"11:00","estado":"completed","origen":"web","notas":null},{"clave":"b03","idempotencyKey":"7f00f7b1ea8135381d606e441bbfbb9dd28455a4a003ddb192f1911555aa3ec3","proveedor":"Memo","servicio":"Afeitado clásico","telefono":"5200201002","semana":-3,"dow":4,"hora":"12:00","estado":"completed","origen":"manual","notas":null},{"clave":"b04","idempotencyKey":"7f432d4304ff37e861eb9491daa1014042e1dcb515d36fe518c45fd08defe316","proveedor":"Beto","servicio":"Arreglo de barba","telefono":"5200201003","semana":-3,"dow":6,"hora":"15:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"b05","idempotencyKey":"5ec9e9d55b522068f5e2133245781447044b3682de888d64dfcc0242cc38fc76","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201004","semana":-3,"dow":3,"hora":"17:00","estado":"completed","origen":"voice","notas":null},{"clave":"b06","idempotencyKey":"23165ee18227706d774e4658682cad4935d6af0ad8ab07cc43e55ec3134aab22","proveedor":"Beto","servicio":"Corte y barba","telefono":"5200201005","semana":-2,"dow":2,"hora":"18:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b07","idempotencyKey":"9b5251ecd9c89580736c747c166af1ed153f755baa7cc954c10d9683f2677d2f","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201006","semana":-2,"dow":5,"hora":"11:30","estado":"completed","origen":"web","notas":null},{"clave":"b08","idempotencyKey":"88c5e413cd5312d0e8b6e60fd994f87e472223862a296e955632e73ebe377bd8","proveedor":"Memo","servicio":"Corte de cabello","telefono":"5200201007","semana":-2,"dow":6,"hora":"19:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b09","idempotencyKey":"441851fc1fc767b7c323fc2f4c836022a479c571cd320688fdaf1d65c45cf133","proveedor":"Beto","servicio":"Afeitado clásico","telefono":"5200201000","semana":-2,"dow":4,"hora":"10:30","estado":"cancelled","origen":"manual","notas":"Pidió cambiar de día"},{"clave":"b10","idempotencyKey":"5d97fb52775e47cdf2aa3c03ecb3101da21dadbe6f857d8f75e974ed6b646c4e","proveedor":"Chuy","servicio":"Arreglo de barba","telefono":"5200201008","semana":-2,"dow":1,"hora":"15:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"b11","idempotencyKey":"c469d63792ce4f8be979ae232812bb94342b77754674cd406c45d5d35761b744","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201001","semana":-1,"dow":3,"hora":"10:00","estado":"completed","origen":"whatsapp","notas":null},{"clave":"b12","idempotencyKey":"d511de1ce852164ccabda421da6c06a6942cbc71011ae18dda5c654e37e1b507","proveedor":"Chuy","servicio":"Corte y barba","telefono":"5200201009","semana":-1,"dow":2,"hora":"13:00","estado":"completed","origen":"web","notas":null},{"clave":"b13","idempotencyKey":"e4d37831810563f99d734e29793744844ebcc3cf4f2aa519434f6d82f7d7b54f","proveedor":"Memo","servicio":"Corte de cabello","telefono":"5200201002","semana":-1,"dow":4,"hora":"12:30","estado":"completed","origen":"voice","notas":null},{"clave":"b14","idempotencyKey":"f1de19db5ebafb4b3aabac5c4606bf27c42cef16230982ae7656a880a4fe014a","proveedor":"Beto","servicio":"Corte y barba","telefono":"5200201003","semana":-1,"dow":5,"hora":"16:00","estado":"no_show","origen":"whatsapp","notas":null},{"clave":"b15","idempotencyKey":"15fe586adc2db5a6454285e1c4d7757c2ccfc81acc3b408474b63f906a1311e7","proveedor":"Chuy","servicio":"Arreglo de barba","telefono":"5200201004","semana":-1,"dow":4,"hora":"18:00","estado":"cancelled","origen":"web","notas":null},{"clave":"b16","idempotencyKey":"2db1e4ea3c0058432a1bdf9295f82af3871b6ca1aa0a6433b3d683bd9fff80e3","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201005","semana":1,"dow":2,"hora":"10:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"b17","idempotencyKey":"e8badc02d5fdd3288aa998a32ce29684bf5fd46cbbe8d1a4cbd0610682564026","proveedor":"Chuy","servicio":"Corte y barba","telefono":"5200201006","semana":1,"dow":3,"hora":"14:00","estado":"confirmed","origen":"web","notas":null},{"clave":"b18","idempotencyKey":"e18377b9d36e5fb3fb559ea22d68dcea0505a4d8b6b4629e4286e47b670b75a1","proveedor":"Memo","servicio":"Corte de cabello","telefono":"5200201007","semana":1,"dow":4,"hora":"13:00","estado":"pending","origen":"whatsapp","notas":null},{"clave":"b19","idempotencyKey":"fe8cbf2230e1f943ae1a88e366d450c21a6885eda59494a44771707e2e0fcbda","proveedor":"Beto","servicio":"Arreglo de barba","telefono":"5200201008","semana":1,"dow":6,"hora":"12:00","estado":"pending","origen":"voice","notas":null},{"clave":"b20","idempotencyKey":"92448768828e928a8c7a499a42cb8dc0f62d96a4f5f859aedb13c9ec98e47b5b","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201009","semana":1,"dow":1,"hora":"11:00","estado":"cancelled","origen":"manual","notas":null},{"clave":"b21","idempotencyKey":"a6545235841c082ab4ee09bf4ea34a0c738fa1efd08dcd55ca1f7733b9eb4992","proveedor":"Beto","servicio":"Corte y barba","telefono":"5200201000","semana":2,"dow":2,"hora":"17:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"b22","idempotencyKey":"f3cbbffe8b1a7df13f530983c3e3d62a68a34df8497884144c39ee018a93161b","proveedor":"Memo","servicio":"Afeitado clásico","telefono":"5200201001","semana":2,"dow":5,"hora":"19:30","estado":"confirmed","origen":"web","notas":null},{"clave":"b23","idempotencyKey":"67203ea92f972e185f5cb24ff5ad7ab3f929bf65159b824b1a797e5d10ccaf46","proveedor":"Chuy","servicio":"Corte de cabello","telefono":"5200201002","semana":2,"dow":3,"hora":"11:00","estado":"confirmed","origen":"whatsapp","notas":null},{"clave":"b24","idempotencyKey":"08500a861340521456f57ed64f9bc4d72ca40735b1983c1c3ba3357707d40d84","proveedor":"Beto","servicio":"Corte de cabello","telefono":"5200201003","semana":2,"dow":6,"hora":"10:00","estado":"pending","origen":"manual","notas":null}],"espera":[{"telefono":"5200201050","nombre":"Ramón Che Pat","servicio":"Corte de cabello","proveedor":"Beto","desde":[1,2],"hasta":[1,6],"ventana":"afternoon","estado":"active"},{"telefono":"5200201051","nombre":"Gael Puc Nah","servicio":"Corte y barba","proveedor":null,"desde":[1,2],"hasta":[2,6],"ventana":"any","estado":"notified"},{"telefono":"5200201052","nombre":"Ismael Ucán Kú","servicio":"Afeitado clásico","proveedor":"Memo","desde":[-1,4],"hasta":[-1,6],"ventana":"evening","estado":"fulfilled"},{"telefono":"5200201053","nombre":"Octavio Mis Tun","servicio":"Arreglo de barba","proveedor":"Chuy","desde":[1,1],"hasta":[2,5],"ventana":"morning","estado":"cancelled"},{"telefono":"5200201054","nombre":"Néstor Cen Aké","servicio":"Corte de cabello","proveedor":null,"desde":[-3,1],"hasta":[-3,6],"ventana":"any","estado":"expired"}]}]}$citas$::jsonb;
  neg jsonb;
  v_org uuid;
  v_vertical text;
  v_marcada boolean;
  v_prop uuid;
  v_user uuid;
  v_tz text;
  v_lunes date;
  v_base date := null;
begin
  select id into v_user from core.staff_user where lower(email) = 'no-existe@example.test';
  if v_user is null then
    raise exception 'seed-citas: no existe un usuario de staff con el correo indicado (--owner-email); el seed no crea credenciales.';
  end if;

  for neg in select * from jsonb_array_elements(v->'negocios') loop
    v_tz := neg->>'timezone';
    v_lunes := date_trunc('week', coalesce(v_base, (now() at time zone v_tz)::date)::timestamp)::date;

    -- 1) organizacion: solo se crea o se actualiza una cuenta DEMO de citas; cualquier otra con ese slug aborta.
    select id, vertical into v_org, v_vertical from core.organization where slug = neg->>'slug';
    if v_org is not null then
      select exists (select 1 from citas.demo_organization d where d.organization_id = v_org) into v_marcada;
      if v_vertical <> 'citas' or not v_marcada then
        raise exception 'seed-citas: el slug % ya existe y no es una cuenta demo de citas; no se toca.', neg->>'slug';
      end if;
      update core.organization set name = neg->>'nombre' where id = v_org;
    else
      insert into core.organization (vertical, name, slug) values ('citas', neg->>'nombre', neg->>'slug') returning id into v_org;
    end if;
    insert into citas.demo_organization (organization_id, seed_version) values (v_org, v->>'seedVersion')
      on conflict (organization_id) do update set seed_version = excluded.seed_version;

    insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
      values (v_user, v_org, null, 'owner', 'owner')
      on conflict do nothing;

    -- 2) sucursal, configuracion y zona horaria
    select id into v_prop from core.property where organization_id = v_org and name = neg->>'sucursal';
    if v_prop is null then
      insert into core.property (organization_id, vertical, name, status) values (v_org, 'citas', neg->>'sucursal', 'active') returning id into v_prop;
    end if;
    insert into citas.tenant_config (organization_id, rubro, default_timezone) values (v_org, neg->>'rubro', v_tz)
      on conflict (organization_id) do update set rubro = excluded.rubro, default_timezone = excluded.default_timezone, updated_at = now();
    insert into citas.property_config (property_id, organization_id, timezone) values (v_prop, v_org, v_tz)
      on conflict (property_id) do update set timezone = excluded.timezone;

    -- 3) servicios (por nombre)
    update citas.services s set duration_minutes = x.minutos, price_cents = x."precioCentavos", is_active = true, updated_at = now()
      from jsonb_to_recordset(neg->'servicios') as x(nombre text, minutos int, "precioCentavos" int)
      where s.organization_id = v_org and s.name = x.nombre;
    insert into citas.services (organization_id, name, duration_minutes, price_cents)
      select v_org, x.nombre, x.minutos, x."precioCentavos"
      from jsonb_to_recordset(neg->'servicios') as x(nombre text, minutos int, "precioCentavos" int)
      where not exists (select 1 from citas.services s where s.organization_id = v_org and s.name = x.nombre);

    -- 4) proveedores (por nombre) y los servicios que ofrece cada uno
    update citas.providers p set role_label = x.rol, property_id = v_prop, is_active = true, updated_at = now()
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, rol text)
      where p.organization_id = v_org and p.display_name = x.nombre;
    insert into citas.providers (organization_id, property_id, display_name, role_label)
      select v_org, v_prop, x.nombre, x.rol
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, rol text)
      where not exists (select 1 from citas.providers p where p.organization_id = v_org and p.display_name = x.nombre);
    insert into citas.provider_services (provider_id, service_id)
      select p.id, s.id
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, servicios jsonb)
      join citas.providers p on p.organization_id = v_org and p.display_name = x.nombre
      cross join lateral jsonb_array_elements_text(x.servicios) as sn(nombre)
      join citas.services s on s.organization_id = v_org and s.name = sn.nombre
      on conflict do nothing;

    -- 5) horario semanal (se reescribe: solo existe en esta organizacion demo) y excepciones
    delete from citas.availability_rules r using citas.providers p
      where r.provider_id = p.id and p.organization_id = v_org;
    insert into citas.availability_rules (provider_id, day_of_week, start_time, end_time)
      select p.id, r.dow, r.inicio::time, r.fin::time
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, reglas jsonb)
      join citas.providers p on p.organization_id = v_org and p.display_name = x.nombre
      cross join lateral jsonb_to_recordset(x.reglas) as r(dow int, inicio text, fin text);
    insert into citas.availability_overrides (provider_id, override_date, is_closed, start_time, end_time, reason)
      select p.id, v_lunes + (e.semana * 7) + (case when e.dow = 0 then 6 else e.dow - 1 end), e.cerrado, e.inicio::time, e.fin::time, e.motivo
      from jsonb_to_recordset(neg->'excepciones') as e(proveedor text, semana int, dow int, cerrado boolean, inicio text, fin text, motivo text)
      join citas.providers p on p.organization_id = v_org and p.display_name = e.proveedor
      on conflict (provider_id, override_date) do update set is_closed = excluded.is_closed, start_time = excluded.start_time,
        end_time = excluded.end_time, reason = excluded.reason;

    -- 6) clientes ficticios (por organizacion + telefono)
    insert into citas.customers (organization_id, full_name, phone, email)
      select v_org, c.nombre, c.telefono, c.email
      from jsonb_to_recordset(neg->'clientes') as c(nombre text, telefono text, email text)
      on conflict (organization_id, phone) do update set full_name = excluded.full_name, email = excluded.email, updated_at = now();

    -- 7) citas: llave de idempotencia determinista; re-ejecutar no duplica ni mueve las ya sembradas
    insert into citas.appointments (organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, notes, idempotency_key, reminder_24h_sent_at)
      select v_org, v_prop, p.id, s.id, cu.id, st.t, st.t + make_interval(mins => s.duration_minutes), a.estado, a.origen, a.notas, a."idempotencyKey",
             case when a.semana < 0 and a.estado in ('completed', 'no_show') then st.t - interval '24 hours' else null end
      from jsonb_to_recordset(neg->'citas') as a(clave text, "idempotencyKey" text, proveedor text, servicio text, telefono text, semana int, dow int, hora text, estado text, origen text, notas text)
      join citas.providers p on p.organization_id = v_org and p.display_name = a.proveedor
      join citas.services s on s.organization_id = v_org and s.name = a.servicio
      join citas.customers cu on cu.organization_id = v_org and cu.phone = a.telefono
      cross join lateral (select ((v_lunes + (a.semana * 7) + (case when a.dow = 0 then 6 else a.dow - 1 end)) + a.hora::time) at time zone v_tz as t) st
      on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing;

    -- 8) lista de espera (por organizacion + telefono ficticio)
    insert into citas.appointment_waitlist (organization_id, customer_phone, customer_name, service_id, provider_id, preferred_date_from, preferred_date_to,
                                            preferred_time_window, status, notified_count, last_notified_at, expires_at)
      select v_org, w.telefono, w.nombre, s.id, p.id,
             v_lunes + (w.desde[1] * 7) + (case when w.desde[2] = 0 then 6 else w.desde[2] - 1 end),
             v_lunes + (w.hasta[1] * 7) + (case when w.hasta[2] = 0 then 6 else w.hasta[2] - 1 end),
             w.ventana, w.estado,
             case when w.estado in ('notified', 'fulfilled') then 1 else 0 end,
             case when w.estado in ('notified', 'fulfilled') then now() - interval '1 day' else null end,
             case when w.estado = 'expired' then now() - interval '1 day' else now() + interval '30 days' end
      from (select x.telefono, x.nombre, x.servicio, x.proveedor, x.ventana, x.estado,
                   array(select jsonb_array_elements_text(x.desde)::int) as desde, array(select jsonb_array_elements_text(x.hasta)::int) as hasta
            from jsonb_to_recordset(neg->'espera') as x(telefono text, nombre text, servicio text, proveedor text, desde jsonb, hasta jsonb, ventana text, estado text)) w
      join citas.services s on s.organization_id = v_org and s.name = w.servicio
      left join citas.providers p on p.organization_id = v_org and p.display_name = w.proveedor
      where not exists (select 1 from citas.appointment_waitlist q where q.organization_id = v_org and q.customer_phone = w.telefono);
  end loop;
end
$seed_fn$;

-- Usuarios: el owner que recibe las cuentas demo y el owner de otra organizacion (B) NO demo.
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c0001', 'owner-demo@example.test', 'Owner de las cuentas demo', 'seed'),
  ('00000000-0000-0000-0000-0000000c0002', 'owner-b@example.test', 'Owner de la organizacion B', 'seed')
on conflict do nothing;

-- Organizacion B (NO demo) con un proveedor, servicio y cliente de MISMO nombre/telefono que los del seed.
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c00b0', 'citas', 'Clinica Real B', 'clinica-real-b')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-0000000c00b0', null, 'owner', 'owner')
on conflict do nothing;
insert into citas.tenant_config (organization_id, rubro) values ('00000000-0000-0000-0000-0000000c00b0', 'dental') on conflict do nothing;
insert into citas.providers (id, organization_id, display_name) values
  ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c00b0', 'Dra. Ana Lozano')
on conflict do nothing;
insert into citas.services (id, organization_id, name, duration_minutes, price_cents) values
  ('00000000-0000-0000-0000-0000000c00b2', '00000000-0000-0000-0000-0000000c00b0', 'Limpieza dental', 30, 99900)
on conflict do nothing;
insert into citas.customers (id, organization_id, full_name, phone, email) values
  ('00000000-0000-0000-0000-0000000c00b3', '00000000-0000-0000-0000-0000000c00b0', 'Cliente real de B', '5200101000', 'real-b@clinica-b.test')
on conflict do nothing;
insert into citas.appointments (id, organization_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values
  ('00000000-0000-0000-0000-0000000c00b4', '00000000-0000-0000-0000-0000000c00b0', '00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c00b2', '00000000-0000-0000-0000-0000000c00b3', now() + interval '3 days', now() + interval '3 days 30 minutes', 'confirmed')
on conflict do nothing;

\echo '=== A1. Dos organizaciones demo creadas, de vertical citas y marcadas en citas.demo_organization ==='
begin;
select public.seed_citas_demo();
select count(*)::int as organizaciones_demo_deberia_ser_2
  from core.organization o join citas.demo_organization d on d.organization_id = o.id
  where o.vertical = 'citas' and o.slug in ('clinica-dental-sonrisa-demo', 'barberia-el-filo-demo');
rollback;

\echo '=== A2. Catalogo: 8 servicios, 6 profesionales con sus servicios, 20 clientes, rubro y zona horaria ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.services s join citas.demo_organization d on d.organization_id = s.organization_id) = 8
  and (select count(*) from citas.providers p join citas.demo_organization d on d.organization_id = p.organization_id) = 6
  and (select count(*) from citas.provider_services ps join citas.providers p on p.id = ps.provider_id join citas.demo_organization d on d.organization_id = p.organization_id) = 17
  and (select count(*) from citas.customers c join citas.demo_organization d on d.organization_id = c.organization_id) = 20
  and (select count(*) from citas.tenant_config t join core.organization o on o.id = t.organization_id where (o.slug, t.rubro, t.default_timezone) in (('clinica-dental-sonrisa-demo', 'dental', 'America/Merida'), ('barberia-el-filo-demo', 'barberia', 'America/Merida'))) = 2
)::int as catalogo_correcto_deberia_ser_1;
rollback;

\echo '=== A3. 49 citas; cada organizacion tiene al menos una cita en CADA uno de los 5 estados ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id) = 49
  and (select count(*) from (
        select a.organization_id, count(distinct a.status) as estados from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id group by a.organization_id
      ) t where t.estados = 5) = 2
  and (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id where a.status = 'no_show') = 6
)::int as citas_por_estado_correctas_deberia_ser_1;
rollback;

\echo '=== A4. Toda cita activa cae dentro del horario semanal de su profesional, en HORA LOCAL (America/Merida) ==='
begin;
select public.seed_citas_demo();
select count(*)::int as citas_fuera_de_horario_deberia_ser_0
  from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id
  where a.status in ('pending', 'confirmed', 'completed')
    and not exists (
      select 1 from citas.availability_rules r
      where r.provider_id = a.provider_id
        and r.day_of_week = extract(dow from (a.starts_at at time zone 'America/Merida'))::int
        and r.start_time <= (a.starts_at at time zone 'America/Merida')::time
        and (a.ends_at at time zone 'America/Merida')::time <= r.end_time
    );
rollback;

\echo '=== A5. Clientes ficticios: correo @example.test y telefono de lada reservada 5200 ==='
begin;
select public.seed_citas_demo();
select count(*)::int as clientes_no_ficticios_deberia_ser_0
  from citas.customers c join citas.demo_organization d on d.organization_id = c.organization_id
  where c.email is null or c.email !~ '^[^@]+@example\.test$' or c.phone !~ '^5200[0-9]{6}$';
rollback;

\echo '=== A6. Lista de espera: 10 filas y los 5 estados en cada organizacion ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.appointment_waitlist w join citas.demo_organization d on d.organization_id = w.organization_id) = 10
  and (select count(*) from (
        select w.organization_id, count(distinct w.status) as estados from citas.appointment_waitlist w join citas.demo_organization d on d.organization_id = w.organization_id group by w.organization_id
      ) t where t.estados = 5) = 2
)::int as lista_de_espera_correcta_deberia_ser_1;
rollback;

\echo '=== A7. Pasado y futuro coherentes: completed/no_show ya ocurrieron; confirmed/pending aun no; la semana en curso esta libre ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id where a.status in ('completed', 'no_show') and a.starts_at >= now()) = 0
  and (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id where a.status in ('confirmed', 'pending') and a.starts_at <= now()) = 0
  and (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id
        where a.starts_at >= date_trunc('week', (now() at time zone 'America/Merida')) at time zone 'America/Merida'
          and a.starts_at < date_trunc('week', (now() at time zone 'America/Merida')) at time zone 'America/Merida' + interval '7 days') = 0
)::int as pasado_y_futuro_coherentes_deberia_ser_1;
rollback;

\echo '=== A8. Excepciones de horario: 5 (3 dias cerrados o reducidos en la clinica, 2 en la barberia) ==='
begin;
select public.seed_citas_demo();
select count(*)::int as excepciones_deberia_ser_5
  from citas.availability_overrides o join citas.providers p on p.id = o.provider_id join citas.demo_organization d on d.organization_id = p.organization_id;
rollback;

\echo '=== B1. Idempotencia: dos corridas no duplican nada (citas, clientes, profesionales, servicios, reglas, excepciones, espera, marcas, membresias) ==='
begin;
select public.seed_citas_demo();
create temp table antes_b1 as
  select (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id) as citas,
         (select count(*) from citas.customers c join citas.demo_organization d on d.organization_id = c.organization_id) as clientes,
         (select count(*) from citas.providers p join citas.demo_organization d on d.organization_id = p.organization_id) as proveedores,
         (select count(*) from citas.services s join citas.demo_organization d on d.organization_id = s.organization_id) as servicios,
         (select count(*) from citas.provider_services ps join citas.providers p on p.id = ps.provider_id join citas.demo_organization d on d.organization_id = p.organization_id) as asignaciones,
         (select count(*) from citas.availability_rules r join citas.providers p on p.id = r.provider_id join citas.demo_organization d on d.organization_id = p.organization_id) as reglas,
         (select count(*) from citas.availability_overrides o join citas.providers p on p.id = o.provider_id join citas.demo_organization d on d.organization_id = p.organization_id) as excepciones,
         (select count(*) from citas.appointment_waitlist w join citas.demo_organization d on d.organization_id = w.organization_id) as espera,
         (select count(*) from citas.demo_organization) as marcas,
         (select count(*) from core.membership m join citas.demo_organization d on d.organization_id = m.organization_id) as membresias,
         (select count(*) from core.property p join citas.demo_organization d on d.organization_id = p.organization_id) as sucursales;
select public.seed_citas_demo();
select (
  select (a.citas, a.clientes, a.proveedores, a.servicios, a.asignaciones, a.reglas, a.excepciones, a.espera, a.marcas, a.membresias, a.sucursales) =
         ((select count(*) from citas.appointments x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.customers x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.providers x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.services x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.provider_services ps join citas.providers p on p.id = ps.provider_id join citas.demo_organization d on d.organization_id = p.organization_id),
          (select count(*) from citas.availability_rules r join citas.providers p on p.id = r.provider_id join citas.demo_organization d on d.organization_id = p.organization_id),
          (select count(*) from citas.availability_overrides o join citas.providers p on p.id = o.provider_id join citas.demo_organization d on d.organization_id = p.organization_id),
          (select count(*) from citas.appointment_waitlist x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.demo_organization),
          (select count(*) from core.membership m join citas.demo_organization d on d.organization_id = m.organization_id),
          (select count(*) from core.property p join citas.demo_organization d on d.organization_id = p.organization_id))
  from antes_b1 a
)::int as sin_duplicados_deberia_ser_1;
rollback;

\echo '=== B2. Re-ejecutar no mueve ni cambia de estado ninguna cita ya sembrada (mismos ids, horarios y estados) ==='
begin;
select public.seed_citas_demo();
create temp table antes as
  select md5(string_agg(a.id::text || a.starts_at::text || a.status, ',' order by a.idempotency_key)) as h
  from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id;
select public.seed_citas_demo();
select ((select h from antes) = (select md5(string_agg(a.id::text || a.starts_at::text || a.status, ',' order by a.idempotency_key))
  from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id))::int as citas_sin_cambios_deberia_ser_1;
rollback;

\echo '=== B3. --fecha-base fija las semanas: con base miercoles 2026-03-04 la cita d16 es el lunes 2026-03-09 a las 09:00 locales y la excepcion de la Dra. Ana el 2026-03-11 ==='
begin;
select public.seed_citas_demo_fecha_base();
select (
  exists (select 1 from citas.appointments a where a.idempotency_key = 'a5787693018708c8fb423587529ada21a838f988d8cca8c6bd7784148c6e00ee' and (a.starts_at at time zone 'America/Merida') = timestamp '2026-03-09 09:00:00')
  and exists (select 1 from citas.availability_overrides o join citas.providers p on p.id = o.provider_id where p.display_name = 'Dra. Ana Lozano' and o.override_date = date '2026-03-11' and o.is_closed)
)::int as semanas_por_fecha_base_deberia_ser_1;
rollback;

\echo '=== B4. El preflight de esquema no reporta faltantes contra la base migrada ==='
begin;
select count(*)::int as faltantes_deberia_ser_0 from (select faltante, migracion from (values
    ('tabla citas.demo_organization', '030_citas_demo_organization'),
    ('funcion citas.demo_limpiar', '030_citas_demo_organization'),
    ('tabla citas.appointment_waitlist', '003_waitlist_and_rate_limit'),
    ('tabla citas.availability_overrides', '001_citas_schema')
  ) as t(faltante, migracion)
  where (faltante = 'tabla citas.demo_organization' and to_regclass('citas.demo_organization') is null)
     or (faltante = 'funcion citas.demo_limpiar' and to_regprocedure('citas.demo_limpiar(uuid)') is null)
     or (faltante = 'tabla citas.appointment_waitlist' and to_regclass('citas.appointment_waitlist') is null)
     or (faltante = 'tabla citas.availability_overrides' and to_regclass('citas.availability_overrides') is null)) f;
rollback;

\echo '=== C1. El owner indicado queda como owner de las dos cuentas demo (y no se crea ningun usuario) ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from core.membership m join citas.demo_organization d on d.organization_id = m.organization_id where m.user_id = '00000000-0000-0000-0000-0000000c0001' and m.platform_role = 'owner' and m.vertical_role = 'owner') = 2
  and (select count(*) from core.staff_user where email like '%@example.test') = 2
)::int as owner_enlazado_deberia_ser_1;
rollback;

\echo '=== C2. Aislamiento: la organizacion B (mismos nombres y mismo telefono de cliente) queda intacta ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.providers where organization_id = '00000000-0000-0000-0000-0000000c00b0') = 1
  and (select count(*) from citas.services where organization_id = '00000000-0000-0000-0000-0000000c00b0' and price_cents = 99900 and duration_minutes = 30) = 1
  and (select full_name from citas.customers where id = '00000000-0000-0000-0000-0000000c00b3') = 'Cliente real de B'
  and (select email from citas.customers where id = '00000000-0000-0000-0000-0000000c00b3') = 'real-b@clinica-b.test'
  and (select count(*) from citas.appointments where organization_id = '00000000-0000-0000-0000-0000000c00b0') = 1
  and not exists (select 1 from citas.demo_organization where organization_id = '00000000-0000-0000-0000-0000000c00b0')
)::int as organizacion_b_intacta_deberia_ser_1;
rollback;

\echo '=== C3. RLS: el staff de la organizacion B no ve ninguna cita, cliente ni marca de las cuentas demo ==='
begin;
select public.seed_citas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0002', true);
select (
  (select count(*) from citas.appointments a where a.organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.customers c where c.organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.demo_organization)
)::int as filas_demo_visibles_para_staff_ajeno_deberia_ser_0;
rollback;

\echo '=== C4. RLS: el owner de las cuentas demo si ve sus 49 citas y las 2 marcas ==='
begin;
select public.seed_citas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0001', true);
select ((select count(*) from citas.appointments) = 49 and (select count(*) from citas.demo_organization) = 2)::int as owner_demo_ve_lo_suyo_deberia_ser_1;
rollback;

\echo '=== C5. RECHAZADO (debe fallar): anon no lee las citas sembradas ==='
begin;
select public.seed_citas_demo();
set local role anon;
select count(*)::int as should_fail from citas.appointments;
rollback;

\echo '=== C6. RECHAZADO (debe fallar): anon no lee la marca demo ==='
begin;
select public.seed_citas_demo();
set local role anon;
select count(*)::int as should_fail from citas.demo_organization;
rollback;

\echo '=== C7. RECHAZADO (debe fallar): un owner de la aplicacion no puede marcar su organizacion como demo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0002', true);
insert into citas.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000c00b0', 'x') returning 1 as should_fail;
rollback;

\echo '=== C8. RECHAZADO (debe fallar): service_role tampoco escribe la marca demo (solo el propietario de la base) ==='
begin;
grant usage on schema citas to service_role; -- en Supabase real el rol ya lo tiene: asi la negativa viene de la TABLA y no del esquema
set local role service_role;
insert into citas.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000c00b0', 'x') returning 1 as should_fail;
rollback;

\echo '=== D1. Limpieza: borra SOLO la organizacion demo indicada (con sus citas, clientes y espera); la otra demo y la organizacion B quedan intactas ==='
begin;
select public.seed_citas_demo();
select citas.demo_limpiar(id) from core.organization where slug = 'clinica-dental-sonrisa-demo';
select (
  not exists (select 1 from core.organization where slug = 'clinica-dental-sonrisa-demo')
  and (select count(*) from citas.appointments a join core.organization o on o.id = a.organization_id where o.slug = 'barberia-el-filo-demo') = 24
  and (select count(*) from citas.appointment_waitlist w join core.organization o on o.id = w.organization_id where o.slug = 'barberia-el-filo-demo') = 5
  and (select count(*) from citas.demo_organization) = 1
  and (select count(*) from citas.appointments where organization_id = '00000000-0000-0000-0000-0000000c00b0') = 1
  and (select count(*) from citas.customers where organization_id = '00000000-0000-0000-0000-0000000c00b0') = 1
)::int as limpieza_aislada_deberia_ser_1;
rollback;

\echo '=== D2. Limpieza completa de las dos demos no deja filas huerfanas de citas en ninguna tabla ==='
begin;
select public.seed_citas_demo();
select citas.demo_limpiar(id) from core.organization where slug in ('clinica-dental-sonrisa-demo', 'barberia-el-filo-demo');
select (
  (select count(*) from citas.appointments where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.customers where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.providers where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.services where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.appointment_waitlist where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.availability_rules r where not exists (select 1 from citas.providers p where p.id = r.provider_id))
  + (select count(*) from citas.demo_organization)
)::int as filas_huerfanas_deberia_ser_0;
rollback;

\echo '=== D3. RECHAZADO (debe fallar): la limpieza se niega a borrar una organizacion NO marcada como demo ==='
begin;
select citas.demo_limpiar('00000000-0000-0000-0000-0000000c00b0') as should_fail;
rollback;

\echo '=== D4. RECHAZADO (debe fallar): un usuario autenticado no puede ejecutar la limpieza ==='
begin;
select public.seed_citas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0001', true);
select citas.demo_limpiar(id) as should_fail from core.organization where slug = 'barberia-el-filo-demo';
rollback;

\echo '=== D5. RECHAZADO (debe fallar): anon no puede ejecutar la limpieza ==='
begin;
select public.seed_citas_demo();
set local role anon;
select citas.demo_limpiar('00000000-0000-0000-0000-0000000c00b0') as should_fail;
rollback;

\echo '=== D6. RECHAZADO (debe fallar): defensa en profundidad: con auth.uid() presente la funcion se niega aunque quien llama sea el propietario de la base ==='
begin;
select public.seed_citas_demo();
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0001', true);
select citas.demo_limpiar(id) as should_fail from core.organization where slug = 'barberia-el-filo-demo';
rollback;

\echo '=== E1. RECHAZADO (debe fallar): el slug ya existe en OTRA vertical; el seed aborta sin tocarla ==='
begin;
insert into core.organization (vertical, name, slug) values ('restaurantes', 'Otra vertical', 'barberia-el-filo-demo');
select public.seed_citas_demo() as should_fail;
rollback;

\echo '=== E2. RECHAZADO (debe fallar): el slug ya existe como cuenta de citas que NO es demo; el seed aborta sin tocarla ==='
begin;
insert into core.organization (vertical, name, slug) values ('citas', 'Cuenta real de citas', 'clinica-dental-sonrisa-demo');
select public.seed_citas_demo() as should_fail;
rollback;

\echo '=== E3. RECHAZADO (debe fallar): sin un usuario de staff con ese correo el seed aborta y no crea credenciales ==='
begin;
select public.seed_citas_demo_sin_owner() as should_fail;
rollback;

\echo '=== E4. Atomicidad: si el seed aborta a media corrida (la segunda cuenta ya existe como cuenta real), no queda NADA de la primera ==='
begin;
insert into core.organization (vertical, name, slug) values ('citas', 'Cuenta real de citas', 'barberia-el-filo-demo');
do $$ begin
  begin
    perform public.seed_citas_demo();
  exception when others then
    null;
  end;
end $$;
select count(*)::int as organizaciones_demo_tras_aborto_deberia_ser_0 from core.organization where slug = 'clinica-dental-sonrisa-demo';
rollback;
