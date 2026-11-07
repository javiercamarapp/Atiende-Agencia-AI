(function(d,w){var r=d.documentElement,K="atiende-diseno",L=w.location,o,t,m,q,l,v;try{l=w.localStorage}catch{l=0}
q=new URLSearchParams(L.search).get("diseno");
try{if(q=="ds3")l.setItem(K,q);else if(q=="off")l.removeItem(K);else q=l.getItem(K)||l.getItem(K+"-org")}catch{m=0}
m=d.querySelector('meta[name="'+K+'-login"]');v=m?m.content.split(","):[];t=L.pathname.split("/");
if(q!="off"&&/^(login|restablecer-contrasena|registro)$/.test(t[2])&&t.length==3&&(v.indexOf(t[1])>=0||v.indexOf("*")>=0))q="ds3";
if(q!="ds3")return;r.dataset.diseno=q;
try{t=l.getItem("atiende-tema");o=!/\/login\/?$/.test(L.pathname)&&(t=="oscuro"||t=="sistema"&&w.matchMedia("(prefers-color-scheme: dark)").matches)}catch{o=0}
r.classList.toggle("dark",!!o);r.dataset.theme=o?"dark":"light";m=d.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",o?"#0e0e10":"#ffffff")})(document,window);
