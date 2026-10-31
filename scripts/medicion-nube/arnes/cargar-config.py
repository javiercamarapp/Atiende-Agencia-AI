#!/usr/bin/env python3
"""Vuelca la configuracion REAL (solo lectura, real-dump/*.json exportado con SELECT) en el Postgres efimero, mismos ids."""
import json,subprocess,sys,os
D=os.path.join(os.path.dirname(os.path.abspath(__file__)),'real-dump')
T=[('organization','core.organization'),('property','core.property'),('branch_detail','restaurantes.branch_detail'),('branch_policy','restaurantes.branch_policy'),
('categories','restaurantes.categories'),('products','restaurantes.products'),('branch_products','restaurantes.branch_products'),('promotions','restaurantes.promotions'),
('known_zone','restaurantes.known_zone'),('whatsapp_agent_config','restaurantes.whatsapp_agent_config'),('branch_voice_config','restaurantes.branch_voice_config'),
('branch_delivery_zone','restaurantes.branch_delivery_zone'),('branch_hours_exception','restaurantes.branch_hours_exception')]
sql=["set session_replication_role=replica;"]
for f,t in T:
    rows=json.load(open(f'{D}/{f}.json'))
    if not rows: continue
    cols=",".join('"'+k+'"' for k in rows[0].keys())  # solo columnas del export: las columnas nuevas de main (p. ej. 053) toman su DEFAULT
    sql.append(f"insert into {t} ({cols}) select {cols} from jsonb_populate_recordset(null::{t}, $j${json.dumps(rows)}$j$);")
sql.append("set session_replication_role=origin;")
open('/tmp/cargar-pm.sql','w').write("\n".join(sql))
r=subprocess.run(['psql','-h','localhost','-p','55491','-U','postgres','-d','pmreal','-v','ON_ERROR_STOP=1','-q','-f','/tmp/cargar-pm.sql'],capture_output=True,text=True)
print(r.stdout[-500:],r.stderr[-1500:])
