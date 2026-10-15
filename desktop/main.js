'use strict';
const {app,BrowserWindow,Menu,shell,dialog}=require('electron');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const SITE='https://khaled.elevatefollowers.com/';
const root=path.join(__dirname,'app');
let win,server,localUrl,mode='online';
function startServer(){return new Promise((resolve,reject)=>{
 server=http.createServer((req,res)=>{
  let name;try{name=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400).end();return;}
  if(name==='/')name='/index.html';
  if(/\.php$/i.test(name)){res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({ok:false,error:'Internet required'}));return;}
  const target=path.resolve(root,'.'+name);
  if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.stat(target,(error,st)=>{if(error||!st.isFile()){res.writeHead(404).end();return;}
   const ext=path.extname(target).toLowerCase(),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.wav':'audio/wav','.mp3':'audio/mpeg','.woff2':'font/woff2'};
   res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff'});fs.createReadStream(target).pipe(res);
  });
 });
 server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port+'/'));
});}
async function switchTo(next){mode=next;win.setTitle('Ayah Fi Daqiqa - '+mode);try{await win.loadURL(mode==='online'?SITE:localUrl);}catch(error){if(mode==='online'){mode='local';await win.loadURL(localUrl);dialog.showMessageBox(win,{type:'warning',message:'تعذر الاتصال بالموقع، تم فتح النسخة المحلية.'});}}}
async function start(){localUrl=await startServer();
 win=new BrowserWindow({width:1450,height:900,minWidth:900,minHeight:600,backgroundColor:'#0b0d12',show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,preload:path.join(__dirname,'preload.js'),partition:'persist:ayah-desktop'}});
 win.once('ready-to-show',()=>win.show());
 win.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))shell.openExternal(url);return {action:'deny'};});
 win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(SITE)&&!url.startsWith(localUrl)){event.preventDefault();if(/^https:\/\//.test(url))shell.openExternal(url);}});
 const template=[{label:'التشغيل',submenu:[{label:'المولّد المتصل',click:()=>switchTo('online')},{label:'واجهة محلية - دون إنترنت قدر الإمكان',click:()=>switchTo('local')},{type:'separator'},{label:'إعادة تحميل',role:'reload'},{type:'separator'},{label:'إغلاق',role:'quit'}]},{label:'عرض',submenu:[{role:'zoomIn'},{role:'zoomOut'},{role:'resetZoom'},{role:'togglefullscreen'}]}];
 Menu.setApplicationMenu(Menu.buildFromTemplate(template));
 await switchTo('online');
 win.webContents.on('did-fail-load',async(_event,_code,_description,url,isMainFrame)=>{if(isMainFrame&&mode==='online'&&url.startsWith(SITE)){mode='local';await win.loadURL(localUrl).catch(()=>{});}});
}
app.whenReady().then(start).catch(e=>{dialog.showErrorBox('خطأ في البرنامج',String(e));app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{try{server?.close();}catch{}});
