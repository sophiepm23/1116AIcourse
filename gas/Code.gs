/**
 * 金禾鍋貼 — 線上訂單 → Google Sheet（Google Apps Script Web App）
 * 部署方式見 docs/google-sheet-setup.md
 *
 * 設計重點
 *  1. 價格以「菜單」工作表為準，後端重算，不信任前端傳來的金額。
 *  2. LockService 防止同時下單造成訂單編號重複。
 *  3. clientId 冪等：網路逾時重送不會產生重複訂單。
 *  4. 防公式注入、honeypot 擋機器人、欄位長度限制。
 */

const DEFAULT_SHEET_ID = '1Wou05-vNnfj3b2q4ol_mcD-MyafkCHdyY0HCZSdOoek'; // 結帳系統試算表（可被指令碼屬性 SHEET_ID 覆寫）

const CFG = {
  ORDERS: '訂單',
  ITEMS: '訂單明細',
  MENU: '菜單',
  TZ: 'Asia/Taipei',
  PACK_FEE: 10,            // 包裝費（有商品就收）
  SHIP_FEE: 160,           // 宅配運費
  FREE_SHIP_OVER: 1500,    // 滿額免運
  MAX_ITEMS: 40,
  MAX_QTY: 99,
  STATUSES: ['新訂單', '製作中', '可取餐', '已完成', '已取消'],
  STORES: { flagship: '永康旗艦店', xinyi: '信義店', banqiao: '板橋店', taichung: '台中勤美店' },
  MODES: { dine: '內用', takeout: '外帶', delivery: '宅配' }
};

const ORDER_HEADERS = ['訂單編號', '建立時間', '狀態', '取餐方式', '門市', '姓名', '手機', '宅配地址', '備註',
  '商品金額', '包裝費', '運費', '總計', '來源', '客戶端ID', '品項摘要'];
const ITEM_HEADERS = ['訂單編號', '商品ID', '商品名稱', '單價', '數量', '小計'];
const MENU_HEADERS = ['商品ID', '商品名稱', '價格', '上架'];

/* ========================= Web App 入口 ========================= */

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json_(placeOrder_(body));
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: String(err.message || err) });
  }
}

/** GET ?action=status&orderNo=GH261116-001&phone=0912345678 → 訂單狀態查詢 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'status') return json_(lookupStatus_(p.orderNo, p.phone));
  return json_({ ok: true, service: 'golden-hearth-orders' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ========================= 下單核心 ========================= */

function placeOrder_(o) {
  if (o.website) return { ok: false, error: 'rejected' };            // honeypot

  const menu = loadMenu_();
  const v = validateOrder_(o, menu);
  if (!v.ok) return { ok: false, error: 'invalid', message: v.error };
  const c = v.order;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet_(CFG.ORDERS, ORDER_HEADERS);
    const itemSheet = getSheet_(CFG.ITEMS, ITEM_HEADERS);

    // 冪等：同一個 clientId 已存在就回傳原訂單
    const dup = findByClientId_(sheet, c.clientId);
    if (dup) return { ok: true, duplicate: true, orderNo: dup.orderNo, total: dup.total };

    const now = new Date();
    const orderNo = nextOrderNo_(sheet, now);
    const t = calcTotals_(c.items, c.mode, menu);
    const summary = t.lines.map(l => l.name + '×' + l.qty).join('、');

    sheet.appendRow([
      orderNo, now, CFG.STATUSES[0], CFG.MODES[c.mode],
      c.mode === 'delivery' ? '' : CFG.STORES[c.storeId],
      safe_(c.name), c.phone, safe_(c.addr), safe_(c.note),
      t.goods, t.pack, t.ship, t.total, c.source, c.clientId, summary
    ]);
    const rows = t.lines.map(l => [orderNo, l.id, l.name, l.price, l.qty, l.price * l.qty]);
    itemSheet.getRange(itemSheet.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
    SpreadsheetApp.flush();

    notifyOwner_(orderNo, c, t, summary);
    return { ok: true, orderNo: orderNo, total: t.total };
  } finally {
    lock.releaseLock();
  }
}

/** 驗證與正規化（純函式，可在 Node 測試） */
function validateOrder_(o, menu) {
  if (!o || typeof o !== 'object') return { ok: false, error: '資料格式錯誤' };
  const mode = String(o.mode || '');
  if (!CFG.MODES[mode]) return { ok: false, error: '取餐方式不正確' };
  const name = String(o.name || '').trim().slice(0, 40);
  if (!name) return { ok: false, error: '請填寫姓名' };
  const phone = String(o.phone || '').replace(/[\s-]/g, '');
  if (!/^09\d{8}$/.test(phone)) return { ok: false, error: '手機格式不正確' };
  const addr = String(o.addr || '').trim().slice(0, 120);
  if (mode === 'delivery' && !addr) return { ok: false, error: '請填寫宅配地址' };
  const storeId = String(o.storeId || '');
  if (mode !== 'delivery' && !CFG.STORES[storeId]) return { ok: false, error: '門市不正確' };
  const clientId = String(o.clientId || '').slice(0, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) return { ok: false, error: '缺少訂單識別碼' };

  if (!Array.isArray(o.items) || !o.items.length || o.items.length > CFG.MAX_ITEMS)
    return { ok: false, error: '購物車是空的或品項過多' };
  const merged = {};
  for (const it of o.items) {
    const id = String(it && it.id || '');
    const qty = Math.floor(Number(it && it.qty));
    if (!menu[id] || !menu[id].active) return { ok: false, error: '商品已下架或不存在：' + id };
    if (!(qty >= 1 && qty <= CFG.MAX_QTY)) return { ok: false, error: '數量不正確' };
    merged[id] = Math.min((merged[id] || 0) + qty, CFG.MAX_QTY);
  }
  const items = Object.keys(merged).map(id => ({ id: id, qty: merged[id] }));
  return {
    ok: true,
    order: {
      mode: mode, storeId: storeId, name: name, phone: phone, addr: addr,
      note: String(o.note || '').trim().slice(0, 200), clientId: clientId,
      source: o.source === 'pwa' ? 'PWA' : '網頁', items: items
    }
  };
}

/** 金額重算（純函式）。規則與前端相同：包裝費 + 宅配滿額免運 */
function calcTotals_(items, mode, menu) {
  const lines = items.map(i => ({ id: i.id, name: menu[i.id].name, price: menu[i.id].price, qty: i.qty }));
  const goods = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const pack = lines.length ? CFG.PACK_FEE : 0;
  const ship = mode === 'delivery' ? (goods >= CFG.FREE_SHIP_OVER ? 0 : CFG.SHIP_FEE) : 0;
  return { lines: lines, goods: goods, pack: pack, ship: ship, total: goods + pack + ship };
}

/** 訂單編號：GHyyMMdd-001（每日流水號，需在鎖內呼叫） */
function nextOrderNo_(sheet, now) {
  const day = Utilities.formatDate(now, CFG.TZ, 'yyMMdd');
  const last = sheet.getLastRow();
  let seq = 0;
  if (last > 1) {
    const col = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (const r of col) {
      const m = /^GH(\d{6})-(\d+)$/.exec(String(r[0]));
      if (m && m[1] === day) seq = Math.max(seq, Number(m[2]));
    }
  }
  return 'GH' + day + '-' + String(seq + 1).padStart(3, '0');
}

function findByClientId_(sheet, clientId) {
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const rows = sheet.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][14] === clientId) return { orderNo: rows[i][0], total: rows[i][12] };
  }
  return null;
}

function lookupStatus_(orderNo, phone) {
  const sheet = getSheet_(CFG.ORDERS, ORDER_HEADERS);
  const last = sheet.getLastRow();
  if (last < 2 || !orderNo || !phone) return { ok: false, error: 'not_found' };
  const rows = sheet.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
  const row = rows.find(r => r[0] === orderNo && String(r[6]) === String(phone).replace(/[\s-]/g, ''));
  return row ? { ok: true, orderNo: orderNo, status: row[2], total: row[12] } : { ok: false, error: 'not_found' };
}

/* ========================= 工作表工具 ========================= */

/** 取得試算表：優先用指令碼屬性 SHEET_ID（獨立專案必須），否則用綁定的試算表 */
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID') || DEFAULT_SHEET_ID;
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('找不到試算表：請在「專案設定 → 指令碼屬性」新增 SHEET_ID');
  return ss;
}

function getSheet_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#3A2619').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    if (name === CFG.ORDERS) {
      sh.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
      sh.getRange('G:G').setNumberFormat('@');                       // 手機保留開頭 0
      sh.getRange('C2:C').setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(CFG.STATUSES, true).setAllowInvalid(false).build());
      sh.setColumnWidths(1, headers.length, 110);
      sh.setColumnWidth(16, 320);
    }
  }
  return sh;
}

function loadMenu_() {
  const sh = getSheet_(CFG.MENU, MENU_HEADERS);
  if (sh.getLastRow() < 2) seedMenu();
  const rows = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 4).getValues();
  const menu = {};
  rows.forEach(r => {
    if (!r[0]) return;
    menu[String(r[0])] = { name: String(r[1]), price: Number(r[2]) || 0, active: !(r[3] === false || r[3] === 'FALSE') };
  });
  return menu;
}

/** 防公式注入：以 = + - @ 開頭的文字前面加單引號 */
function safe_(s) {
  s = String(s || '');
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/* ========================= 通知 / 報表 ========================= */

function notifyOwner_(orderNo, c, t, summary) {
  const to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  if (!to) return;
  try {
    MailApp.sendEmail({
      to: to,
      subject: '【新訂單】' + orderNo + '｜' + CFG.MODES[c.mode] + '｜NT$' + t.total,
      body: [
        '訂單編號：' + orderNo,
        '取餐方式：' + CFG.MODES[c.mode] + (c.mode === 'delivery' ? '（' + c.addr + '）' : '・' + CFG.STORES[c.storeId]),
        '顧客：' + c.name + ' ' + c.phone,
        '品項：' + summary,
        '備註：' + (c.note || '—'),
        '總計：NT$' + t.total
      ].join('\n')
    });
  } catch (err) { console.error('寄信失敗：' + err); }   // 通知失敗不應影響下單
}

/** 每日營收摘要（由時間觸發器於 21:30 執行） */
function dailySummary() {
  const to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  const sh = getSheet_(CFG.ORDERS, ORDER_HEADERS);
  const last = sh.getLastRow();
  if (!to || last < 2) return;
  const today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  const rows = sh.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues()
    .filter(r => r[1] instanceof Date && Utilities.formatDate(r[1], CFG.TZ, 'yyyy-MM-dd') === today && r[2] !== '已取消');
  const sum = rows.reduce((s, r) => s + Number(r[12]), 0);
  MailApp.sendEmail(to, '【金禾鍋貼】' + today + ' 日報：' + rows.length + ' 筆 / NT$' + sum,
    '今日有效訂單 ' + rows.length + ' 筆，營收 NT$' + sum + '。');
}

/* ========================= 初始化（在試算表選單執行） ========================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('金禾訂單')
    .addItem('1. 初始化工作表', 'setup')
    .addItem('2. 重新匯入預設菜單', 'seedMenu')
    .addItem('3. 安裝每日報表（21:30）', 'installTriggers')
    .addToUi();
}

function setup() {
  getSheet_(CFG.ORDERS, ORDER_HEADERS);
  getSheet_(CFG.ITEMS, ITEM_HEADERS);
  if (getSheet_(CFG.MENU, MENU_HEADERS).getLastRow() < 2) seedMenu();
}

/** 預設菜單（與網站 MENU / GIFTS 的 id 與價格一致） */
function seedMenu() {
  const data = [
    ['p1', '招牌高麗菜鍋貼', 70], ['p2', '韭黃鮮蝦鍋貼', 110], ['p3', '麻辣牛肉鍋貼', 120], ['p4', '櫻花蝦玉米鍋貼', 95],
    ['d1', '鮮肉水餃', 65], ['d2', '玉米豬肉水餃', 70], ['d3', '紅油抄手', 90], ['d4', '香菇素食水餃', 70],
    ['s1', '酸辣湯', 45], ['s2', '玉米濃湯', 40], ['s3', '古早味豆漿', 30], ['s4', '手作冬瓜檸檬', 40],
    ['c1', '涼拌小黃瓜', 35], ['c2', '滷味拼盤', 60], ['c3', '皮蛋豆腐', 45], ['c4', '麻辣鴨血', 55],
    ['g1', '招財金磚鍋貼禮盒', 980], ['g2', '闔家團圓水餃組', 1180], ['g3', '職人綜合嚐鮮盒', 1380]
  ].map(r => r.concat([true]));
  const sh = getSheet_(CFG.MENU, MENU_HEADERS);
  sh.getRange(2, 1, data.length, 4).setValues(data);
  sh.getRange(2, 4, data.length, 1).insertCheckboxes();
}

function installTriggers() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailySummary').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailySummary').timeBased().atHour(21).nearMinute(30).everyDays(1).inTimezone(CFG.TZ).create();
}
