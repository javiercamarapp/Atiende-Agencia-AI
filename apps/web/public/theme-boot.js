(function(d,w){var r=d.documentElement,c=w.location,k="atiende-diseno",o,t,m,q,l;try{l=w.localStorage}catch{}
q=new URLSearchParams(c.search).get("diseno");
try{if(q=="ds3")l.setItem(k,q);else if(q=="off")l.removeItem(k);else q=l.getItem(k)}catch{}
if(q!="ds3")return;r.dataset.diseno=q;
try{t=l.getItem("atiende-tema");o=!/\/login\/?$/.test(c.pathname)&&(t=="oscuro"||t=="sistema"&&w.matchMedia("(prefers-color-scheme: dark)").matches)}catch{}
r.classList.toggle("dark",!!o);m=d.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",o?"#0e0e10":"#ffffff")})(document,window);
