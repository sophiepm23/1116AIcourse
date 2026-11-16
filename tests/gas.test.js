// 在 Node 以記憶體版 Sheet 模擬測試 gas/Code.gs
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const sheets = {}; const mails = [];
class Sheet {
  constructor(n){this.n=n;this.rows=[];}
  getLastRow(){return this.rows.length;}
  getRange(r,c,nr=1,nc=1){const s=this;const rg={
    getValues:()=>s.rows.slice(r-1,r-1+nr).map(x=>Array.from({length:nc},(_,i)=>x[c-1+i]??'')),
    setValues:v=>{v.forEach((row,i)=>{s.rows[r-1+i]=s.rows[r-1+i]||[];row.forEach((x,j)=>s.rows[r-1+i][c-1+j]=x);});return rg;},
    setFontWeight(){return rg},setBackground(){return rg},setFontColor(){return rg},setNumberFormat(){return rg},
    setDataValidation(){return rg},insertCheckboxes(){return rg}};return rg;}
  appendRow(a){this.rows.push(a);} setFrozenRows(){} setColumnWidths(){} setColumnWidth(){}
}
const book = {getSheetByName:n=>sheets[n]||null,insertSheet:n=>sheets[n]=new Sheet(n)};
const ctx = {console, Date, JSON, Math, Number, String, Array, Object, RegExp,
  SpreadsheetApp:{getActiveSpreadsheet:()=>global.__unbound?null:book,openById:id=>{if(id!=='SID123'&&id!=='1Wou05-vNnfj3b2q4ol_mcD-MyafkCHdyY0HCZSdOoek')throw new Error('bad id');return book;},flush(){},
    newDataValidation:()=>({requireValueInList(){return this},setAllowInvalid(){return this},build(){return{}}})},
  LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
  Utilities:{formatDate:(d,tz,f)=>{const p=n=>String(n).padStart(2,'0');return f==='yyMMdd'?p(d.getFullYear()%100)+p(d.getMonth()+1)+p(d.getDate()):d.toISOString().slice(0,10)}},
  MailApp:{sendEmail:m=>mails.push(m)},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>k==='SHEET_ID'?(global.__sid||null):'owner@example.com'})},
  ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({s,setMimeType(){return this}})}};
vm.createContext(ctx); vm.runInContext(fs.readFileSync(__dirname+'/../gas/Code.gs','utf8'), ctx);
const post = o => JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(o)}}).s);
const base = {mode:'takeout',storeId:'xinyi',name:'王小明',phone:'0912-345-678',note:'',clientId:'abcdefgh-1',items:[{id:'p1',qty:2},{id:'s1',qty:1}]};

let r = post(base);
assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.total, 70*2+45+10);       // 後端重算
assert.match(r.orderNo, /^GH\d{6}-001$/);
assert.strictEqual(sheets['訂單'].rows[1][6], '0912345678');                         // 手機保留 0
assert.strictEqual(sheets['訂單明細'].rows.length, 3);                                // 表頭 + 2 品項
assert.strictEqual(mails.length, 1);

const again = post(base);                                                           // 冪等
assert.ok(again.duplicate && again.orderNo === r.orderNo); assert.strictEqual(sheets['訂單'].rows.length, 2);

const r2 = post({...base, clientId:'abcdefgh-2', mode:'delivery', addr:'台北市', name:'=HYPERLINK("x")', items:[{id:'p1',qty:1},{id:'p1',qty:1}]});
assert.ok(r2.ok); assert.match(r2.orderNo, /-002$/);
assert.strictEqual(r2.total, 140+10+160);                                            // 宅配運費、重複品項合併
assert.strictEqual(sheets['訂單'].rows[2][5], "'=HYPERLINK(\"x\")");                 // 防公式注入
const r3 = post({...base, clientId:'abcdefgh-3', mode:'delivery', addr:'x', items:[{id:'g3',qty:2}]});
assert.strictEqual(r3.total, 2760+10);                                               // 滿額免運

for (const [bad, why] of [[{...base,clientId:'abcdefgh-4',phone:'123'},'phone'],[{...base,clientId:'abcdefgh-5',items:[{id:'zz',qty:1}]},'item'],
  [{...base,clientId:'abcdefgh-6',items:[{id:'p1',qty:0}]},'qty'],[{...base,clientId:'abcdefgh-7',storeId:'nope'},'store'],
  [{...base,clientId:'abcdefgh-8',website:'spam'},'honeypot'],[{...base,clientId:'x'},'clientId']])
  assert.strictEqual(post(bad).ok, false, why);
const st = JSON.parse(ctx.doGet({parameter:{action:'status',orderNo:r.orderNo,phone:'0912345678'}}).s);
assert.ok(st.ok && st.status==='新訂單');
assert.strictEqual(JSON.parse(ctx.doGet({parameter:{action:'status',orderNo:r.orderNo,phone:'0900000000'}}).s).ok, false);
// 獨立專案（未綁定試算表）：沒有 SHEET_ID 要明確報錯，設定後可正常寫入
global.__unbound = true;
// 未設 SHEET_ID 時使用內建預設試算表 ID，不再因 null 失敗
assert.ok(post({...base, clientId:'abcdefgh-9'}).ok);
global.__sid = 'SID123';
assert.ok(post({...base, clientId:'abcdefgh-10'}).ok);
console.log('GAS tests passed');
