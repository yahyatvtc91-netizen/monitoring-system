"use strict";

const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];
const DB_NAME = "monitoring_portable_v1";
const STORE = "app";
const STATE_KEY = "state";
const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"];
let state;
let db;
let auditRows = [];
let sectionCache;

function uid(prefix = "id") { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function norm(v) { return String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase().replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي"); }
function arabicDigits(v) { return String(v).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[Number(d)]); }
function westernDigits(v) { return String(v??"").replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))); }
function hijriDate(v) {
  const raw=westernDigits(v).trim().replace(/[.\-]/g,"/");
  const m=raw.match(/^(1[34]\d{2})\/(\d{1,2})\/(\d{1,2})$/);
  if(!m || +m[2]<1 || +m[2]>12 || +m[3]<1 || +m[3]>30) return "";
  return `${m[1]}/${m[2].padStart(2,"0")}/${m[3].padStart(2,"0")}`;
}
function displayDate(v) { return arabicDigits(String(v??"")); }
function periodTime(exam) { return state.periods.find(p=>Number(p.id)===Number(exam.period))?.time||"غير محدد"; }
function trainingTermLabel(){
  const code=westernDigits(state.meta.term||"").replace(/\D/g,"");
  const full=code.match(/^(1[34]\d{2})(10|20)$/);
  if(full)return `الفصل التدريبي ${full[2]==="10"?"الأول":"الثاني"} ${arabicDigits(Number(full[1])+1)}`;
  // الصيغة المختصرة مثل 14420 لا تحمل سنة كاملة؛ نستمد السنة من تواريخ الاختبارات.
  const short=code.match(/^\d{3}(10|20)$/);
  if(short){
    const date=state.exams.map(e=>westernDigits(e.date).match(/^(1[34]\d{2})\//)?.[1]).find(Boolean)
      ||state.days.map(d=>westernDigits(d.date).match(/^(1[34]\d{2})\//)?.[1]).find(Boolean)
      ||new Intl.DateTimeFormat("en-u-ca-islamic-umalqura",{year:"numeric"}).format(new Date()).match(/1[34]\d{2}/)?.[0];
    return date?`الفصل التدريبي ${short[1]==="10"?"الأول":"الثاني"} ${arabicDigits(date)}`:"";
  }
  return state.meta.term?`الفصل التدريبي: ${state.meta.term}`:"";
}
function scheduleNotes(exam){
  const notes=[];
  if(!exam.room)notes.push("لم تُعيّن قاعة");
  else if(!validRoomLabel(exam.room))notes.push("قاعة غير معروفة");
  else if(roomRecord(exam.room)?.enabled===false)notes.push("القاعة مستبعدة");
  if(!exam.inv1&&!exam.inv2)notes.push("لم يُعيّن مراقبان");
  else if(!exam.inv1||!exam.inv2)notes.push("نقص مراقب");
  return notes.join("؛ ")||"مكتمل";
}
function toast(msg) { const e = $("#toast"); e.textContent = msg; e.classList.add("show"); setTimeout(() => e.classList.remove("show"), 2600); }
function todayStamp() { return new Date().toLocaleString("ar-SA", {dateStyle:"medium", timeStyle:"short"}); }
function dayKey(exam) { const time=exam.date?calendarTime(exam.date):null;return time!==null?hijriFromTime(time):westernDigits(exam.date||"").replace(/[.\-]/g,"/") || `${exam.week||""}|${exam.day||""}`; }
function slotKey(exam) { return `${dayKey(exam)}|${Number(exam.period)}`; }
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function defaultDays() {
  const out = [];
  for (let w = 1; w <= 4; w++) for (const day of AR_DAYS) out.push({id:uid("day"), week:w, day, date:"", active:true});
  return out;
}
function defaultState() {
  return {
    version: 1,
    meta: {term:"", announcementTerm:"", announcementInstructions:"", ss01Name:"", ss01ImportedAt:"", examName:"", examImportedAt:""},
    auditExceptions: {}, availabilityPinned: {},
    ss01: [], ss01Headers: [],
    trainers: [], rooms: [], exams: [], availability: {},
    periods: [
      {id:1, name:"الفترة الأولى", time:"08:00 ص", active:true},
      {id:2, name:"الفترة الثانية", time:"10:00 ص", active:true},
      {id:3, name:"الفترة الثالثة", time:"12:00 م", active:true}
    ],
    days: defaultDays()
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dbGet(key) { return new Promise((resolve, reject) => { const r = db.transaction(STORE).objectStore(STORE).get(key); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); }); }
function dbSet(key, value) { return new Promise((resolve, reject) => { const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).put(value,key); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); }
let saveTimer;
function saveSoon() {
  if (typeof document === "undefined") return;
  $("#saveState").textContent = "جارٍ الحفظ…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await dbSet(STATE_KEY, state); $("#saveState").textContent = "محفوظ محليًا"; renderMetrics(); }, 250);
}

function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows=[]; let row=[], cell="", quoted=false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) { if (c==='"' && text[i+1]==='"') { cell+='"'; i++; } else if (c==='"') quoted=false; else cell+=c; }
    else if (c==='"') quoted=true;
    else if (c===',') { row.push(cell); cell=""; }
    else if (c==='\n') { row.push(cell.replace(/\r$/, "")); rows.push(row); row=[]; cell=""; }
    else cell+=c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ""));
}

async function unzipXlsx(buffer) {
  const b = new Uint8Array(buffer), dv = new DataView(buffer);
  let eocd=-1;
  for (let i=b.length-22;i>=Math.max(0,b.length-65557);i--) if (dv.getUint32(i,true)===0x06054b50) { eocd=i; break; }
  if (eocd<0) throw new Error("ملف XLSX غير صالح");
  const count=dv.getUint16(eocd+10,true), cdOffset=dv.getUint32(eocd+16,true), dec=new TextDecoder("utf-8");
  const files={}; let p=cdOffset;
  for (let n=0;n<count;n++) {
    if (dv.getUint32(p,true)!==0x02014b50) break;
    const method=dv.getUint16(p+10,true), size=dv.getUint32(p+20,true), nameLen=dv.getUint16(p+28,true), extraLen=dv.getUint16(p+30,true), commentLen=dv.getUint16(p+32,true), local=dv.getUint32(p+42,true);
    const name=dec.decode(b.slice(p+46,p+46+nameLen));
    const localNameLen=dv.getUint16(local+26,true), localExtra=dv.getUint16(local+28,true), start=local+30+localNameLen+localExtra;
    let raw=b.slice(start,start+size);
    if (method===8) {
      const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      raw=new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (method!==0) throw new Error("طريقة ضغط XLSX غير مدعومة");
    files[name]=raw; p+=46+nameLen+extraLen+commentLen;
  }
  return files;
}
function colIndex(ref) { const m=String(ref).match(/[A-Z]+/); if(!m)return 0; let x=0; for(const c of m[0])x=x*26+c.charCodeAt(0)-64; return x-1; }
function decodeXml(v) { return String(v??"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))); }
function xmlTexts(fragment) { return [...String(fragment).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m=>decodeXml(m[1])).join(""); }
async function parseXlsx(buffer) {
  const files=await unzipXlsx(buffer), dec=new TextDecoder("utf-8");
  const shared=[];
  if(files["xl/sharedStrings.xml"]) for(const si of dec.decode(files["xl/sharedStrings.xml"]).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) shared.push(xmlTexts(si[1]));
  let sheetName="xl/worksheets/sheet1.xml";
  if(!files[sheetName]) sheetName=Object.keys(files).find(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if(!sheetName) throw new Error("لا توجد ورقة بيانات في الملف");
  const rows=[], sheetXml=dec.decode(files[sheetName]);
  for(const r of sheetXml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const arr=[];
    for(const c of r[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs=c[1], body=c[2], ref=(attrs.match(/\br="([^"]+)"/)||[])[1]||"A1", type=(attrs.match(/\bt="([^"]+)"/)||[])[1]||"";
      const idx=colIndex(ref); let val="";
      if(type==="inlineStr") val=xmlTexts(body);
      else { const v=(body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)||[])[1]; val=v?decodeXml(v):""; if(type==="s")val=shared[Number(val)]??""; }
      arr[idx]=val;
    }
    rows.push(arr.map(v=>v??""));
  }
  return rows.filter(r=>r.some(v=>String(v).trim()!==""));
}
async function readTable(file) {
  if(file.name.toLowerCase().endsWith(".csv")) return parseCsv(await file.text());
  if(file.name.toLowerCase().endsWith(".xlsx")) return parseXlsx(await file.arrayBuffer());
  throw new Error("اختر ملف CSV أو XLSX");
}
function rowsToObjects(rows) {
  if(rows.length<2) return {headers:rows[0]||[], records:[]};
  const headers=rows[0].map(v=>String(v).trim());
  return {headers, records:rows.slice(1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??""])))};
}
function findHeader(headers, patterns) { for(const p of patterns){const h=headers.find(v=>p.test(norm(v)));if(h)return h;}return ""; }
function fieldMap(headers) {
  return {
    term:findHeader(headers,[/الفصل التدريبي/,/الفصل/]), dept:findHeader(headers,[/^القسم$/, /القسم التدريبي/]),
    course:findHeader(headers,[/^اسم المقرر$/, /اسم الماده/, /^المقرر$/]), code:findHeader(headers,[/رمز المقرر/,/كود المقرر/,/^المقرر$/]),
    section:findHeader(headers,[/رقم الشعبه/,/^الشعبه$/, /الرقم المرجعي/]), trainerId:findHeader(headers,[/رقم المدرب/,/الرقم الوظيفي/,/الرقم الوظيفى/]),
    trainer:findHeader(headers,[/اسم المدرب/,/^المدرب$/]), room:findHeader(headers,[/^قاعه$/, /رمز القاعه/,/اسم القاعه/]),
    capacity:findHeader(headers,[/السعه/,/مسجلين/,/عدد المسجلين/]), trainingType:findHeader(headers,[/نوع التدريب/,/نوع الشعبه/,/نوع الجدوله/,/طريقه التدريب/,/تصنيف التدريب/])
  };
}
function trainingIncluded(v) { const s=norm(v); return !/(عملي|تعاون|عن بعد|ذاتي|افتراضي)/.test(s); }
function rowIncluded(row,map){
  const relevant=state.ss01Headers.filter(h=>/نوع الشعبه|نوع التدريب|طريقه التدريب|نمط التدريب|تصنيف التدريب/.test(norm(h)));
  return trainingIncluded([map.trainingType?row[map.trainingType]:"",...relevant.map(h=>row[h]),map.course?row[map.course]:""].join(" "));
}
function eligibleSections(){
  if(sectionCache?.source===state.ss01&&sectionCache.length===state.ss01.length)return sectionCache.included;
  const m=fieldMap(state.ss01Headers),found=new Map();
  for(const r of state.ss01){if(!rowIncluded(r,m))continue;const section=String(r[m.section]||"").trim();if(!section||found.has(norm(section)))continue;
    found.set(norm(section),{section,course:String(r[m.course]||"").trim(),code:String(r[m.code]||"").trim(),type:String(r[m.trainingType]||"").trim(),trainer:String(r[m.trainer]||"").trim()});
  }
  sectionCache={source:state.ss01,length:state.ss01.length,included:found,known:new Set(state.ss01.map(r=>norm(r[m.section])).filter(Boolean))};
  return found;
}
function eligibleExams(){const included=eligibleSections(),known=sectionCache.known;return state.exams.filter(e=>!known.has(norm(e.section))||included.has(norm(e.section)));}
function formatRoom(code) {
  const digits=westernDigits(code).replace(/\D/g,"");
  if(/^\d{10}$/.test(digits)) return `مبنى ${arabicDigits(digits.slice(3,5))} – قاعة ${arabicDigits(digits.slice(-3))}`;
  return String(code??"").trim();
}
function roomCode(room){const digits=westernDigits(room?.original||"").replace(/\D/g,"");return /^\d{10}$/.test(digits)?digits:"";}
function roomRecord(label){const value=westernDigits(label),digits=value.replace(/\D/g,"");const parts=value.match(/مبنى\s*(\d{1,2}).*قاعة\s*(\d{1,3})/);return state.rooms.find(r=>r.name===label||r.original===label||(roomCode(r)&&roomCode(r)===digits)||(parts&&roomCode(r)&&buildingOfRoom(r)===parts[1].padStart(2,"0")&&roomCode(r).slice(-3)===parts[2].padStart(3,"0")));}
function validRoomLabel(label){const r=roomRecord(label);return r&&roomCode(r)?formatRoom(r.original):"";}
function roomAllowed(row, map) {
  const focus=[map.trainingType,map.room].filter(Boolean).map(h=>row[h]).join(" ");
  const type=map.trainingType?norm(row[map.trainingType]):"";
  return rowIncluded(row,map) && /^\d{10}$/.test(westernDigits(row[map.room]).replace(/\D/g,"")) && !/(معمل|مختبر|حاسب|ورشه|ورشة)/.test(norm(focus)) && (!type||/نظري/.test(type));
}

async function importSS01(file) {
  const {headers,records}=rowsToObjects(await readTable(file)); if(!records.length) throw new Error("الملف لا يحتوي سجلات");
  const m=fieldMap(headers); if(!m.trainer || !m.course || !m.section) throw new Error("تعذر العثور على أعمدة المدرب والمقرر والشعبة");
  state.ss01Headers=headers; state.ss01=records; state.meta.ss01Name=file.name; state.meta.ss01ImportedAt=todayStamp(); state.meta.term=m.term?String(records[0][m.term]||""):"";
  const existing=new Map(state.trainers.map(t=>[t.id||norm(t.name),t]));
  for(const r of records) {
    const name=String(r[m.trainer]||"").trim(), id=String(r[m.trainerId]||"").trim(); if(!name||name==="-")continue;
    const key=id||norm(name), old=existing.get(key), dept=String(r[m.dept]||"").trim();
    if(old) { old.name=name; if(id)old.id=id; if(dept && !(old.dept||"").split("،").map(norm).includes(norm(dept))) old.dept=old.dept?`${old.dept}، ${dept}`:dept; old.source="SS01"; }
    else { const t={key:uid("tr"),id,name,dept,active:true,max:999,allowOwnExamMonitoring:false,source:"SS01"}; state.trainers.push(t); existing.set(key,t); }
  }
  state.rooms=state.rooms.filter(r=>r.source!=="SS01"||roomCode(r));
  const roomMap=new Map(state.rooms.map(r=>[norm(r.original||r.name),r]));
  if(m.room) for(const r of records) {
    const original=String(r[m.room]||"").trim(); if(!original||original==="-"||!roomAllowed(r,m))continue;
    const key=norm(original); if(!roomMap.has(key)){const room={key:uid("room"),name:formatRoom(original),original,capacity:num(r[m.capacity],0),source:"SS01"};state.rooms.push(room);roomMap.set(key,room);}
  }
  state.trainers.sort((a,b)=>a.dept.localeCompare(b.dept,"ar")||a.name.localeCompare(b.name,"ar"));
  state.rooms.sort((a,b)=>String(a.original).localeCompare(String(b.original),"ar",{numeric:true}));
  saveSoon(); renderAll();
}

function excelDate(v) {
  if(!v)return "";
  const hijri=hijriDate(v);if(hijri)return hijri;
  if(/^\d{4}-\d{1,2}-\d{1,2}/.test(v))return String(v).slice(0,10);
  const n=Number(v); if(Number.isFinite(n)&&n>20000){const d=new Date(Date.UTC(1899,11,30)+n*86400000);return d.toISOString().slice(0,10);}
  const d=new Date(v); return isNaN(d)?String(v):d.toISOString().slice(0,10);
}
function examMap(headers) { return {day:findHeader(headers,[/^اليوم$/]),date:findHeader(headers,[/التاريخ/]),period:findHeader(headers,[/الفتره/,/الجلسه/]),time:findHeader(headers,[/الوقت/,/الزمن/]),course:findHeader(headers,[/اسم المقرر/,/^المقرر$/, /الماده/]),section:findHeader(headers,[/رقم الشعبه/,/^الشعبه$/, /الرقم المرجعي/]),room:findHeader(headers,[/القاعه/])}; }
function periodNo(v) { const s=norm(v); if(/اول|اولي|1/.test(s))return 1;if(/ثاني|2/.test(s))return 2;if(/ثالث|3/.test(s))return 3;return num(v,1); }
function parseDayDate(v) {
  const s=westernDigits(v).replace(/\r/g,"").trim(), day=AR_DAYS.find(d=>norm(s).includes(norm(d)))||"";
  const date=(s.match(/(?:14\d{2}|20\d{2})[\/-]\d{1,2}[\/-]\d{1,2}/)||[])[0]||"";
  return {day,date};
}
function extractPeriodTime(v) {
  const s=String(v??"").replace(/\s+/g," ").trim();
  const m=s.match(/من\s*([0-9٠-٩:]+)\s*(?:ص|م)?\s*(?:الى|إلى)\s*([0-9٠-٩:]+)/);
  return m?`${m[1]} – ${m[2]}`:"";
}
function parseExamMatrix(rows) {
  let header=-1, starts=[];
  for(let i=0;i<Math.min(rows.length,20);i++){
    const found=[];for(let c=0;c<(rows[i]||[]).length;c++)if(/الرمز/.test(norm(rows[i][c])))found.push(c);
    if(found.length>=2){header=i;starts=found;break;}
  }
  if(header<0)return [];
  const titleRows=rows.slice(Math.max(0,header-2),header), periods=starts.map((start,i)=>{
    const title=titleRows.flatMap(r=>r.slice(Math.max(0,start-2),start+3)).find(v=>/الفتره/.test(norm(v)))||"";
    return {number:i+1,time:extractPeriodTime(title)};
  });
  const out=[];let currentDay="",currentDate="";
  for(let r=header+1;r<rows.length;r++){
    const row=rows[r]||[], dd=parseDayDate(row[0]);
    if(dd.day)currentDay=dd.day;if(dd.date)currentDate=dd.date;
    for(let i=0;i<starts.length;i++){
      const start=starts[i], code=String(row[start]??"").trim(), room=String(row[start+1]??"").trim(), course=String(row[start+2]??"").trim();
      if(!course&&!code)continue;
      out.push({day:currentDay,date:currentDate,period:periods[i].number,time:periods[i].time,course,courseCode:code,section:"",room});
    }
  }
  return out;
}
function parseExamSource(rows) {
  const matrix=parseExamMatrix(rows);if(matrix.length)return matrix;
  const {headers,records}=rowsToObjects(rows),em=examMap(headers);
  if(!em.course)return [];
  return records.map(r=>({day:String(r[em.day]||"").trim(),date:excelDate(r[em.date]),period:periodNo(r[em.period]),time:String(r[em.time]||"").trim(),course:String(r[em.course]||"").trim(),courseCode:"",section:em.section?String(r[em.section]||"").trim():"",room:String(r[em.room]||"").trim()})).filter(r=>r.course);
}
async function prepareExamSchedules(files) {
  if(!state.ss01.length) throw new Error("استورد SS01 أولًا");
  const selected=[...files];if(!selected.length)return {selected,added:[],results:[]};
  const sm=fieldMap(state.ss01Headers), added=[], seen=new Map();
  for(const ex of state.exams)if(ex.section)seen.set(norm(ex.section),slotKey(ex));
  const results=[];
  for(const file of selected){
    const source=parseExamSource(await readTable(file));
    if(!source.length)throw new Error(`لم يُعثر على مقررات في «${file.name}». لم يُضف أي ملف.`);
    let matched=0,duplicates=0,unmatched=0;
    for(const r of source) {
    const course=r.course, section=r.section;
    let matches=state.ss01.filter(s=>rowIncluded(s,sm) && (section?norm(s[sm.section])===norm(section):((course&&norm(s[sm.course])===norm(course))||(r.courseCode&&norm(s[sm.code])===norm(r.courseCode)))));
    if(!matches.length&&course)matches=state.ss01.filter(s=>rowIncluded(s,sm) && (norm(s[sm.course]).includes(norm(course))||norm(course).includes(norm(s[sm.course]))));
    const unique=new Map(); for(const s of matches)unique.set(String(s[sm.section]||""),s);
    if(!unique.size){unmatched++;continue;}
    for(const [sec,s] of unique) {
      const knownRoom=state.rooms.find(x=>norm(x.original)===norm(r.room)||norm(x.name)===norm(r.room));
      const ex={id:uid("ex"),day:r.day,date:r.date,period:r.period,time:r.time,course:course||String(s[sm.course]||r.courseCode).trim(),section:sec,dept:String(s[sm.dept]||"").trim(),courseTrainer:String(s[sm.trainer]||"").trim(),room:knownRoom?.name||r.room,inv1:"",inv2:"",pinned:false,notes:""};
      const key=norm(sec),slot=slotKey(ex),previous=seen.get(key);
      if(previous&&previous!==slot)throw new Error(`الشعبة ${sec} في «${file.name}» لها موعد آخر موجود في الجدول أو الملفات المختارة. أوقف الاستيراد دون إضافة أي ملف.`);
      if(previous===slot){duplicates++;continue;}
      seen.set(key,slot);added.push(ex);matched++;
    }
    }
    results.push({name:file.name,matched,duplicates,unmatched});
    if(!matched&&!duplicates)throw new Error(`لم تُطابق أي شعبة من «${file.name}» مع SS01. أوقف الاستيراد دون إضافة أي ملف.`);
  }
  return {selected,added,results};
}
async function importExamSchedules(files) {
  const {selected,added,results}=await prepareExamSchedules(files);
  if(!selected.length)return;
  const calendar=importedCalendar([...state.exams,...added]);
  state.exams.push(...added);state.meta.examName=selected.map(f=>f.name).join("، ");state.meta.examNames=[...new Set([...(state.meta.examNames||[]),...selected.map(f=>f.name)])];state.meta.examImportedAt=todayStamp();
  if(calendar)applyImportedCalendar(calendar);
  saveSoon();renderAll();runAudit();
  $("#examImportResult").innerHTML=results.map(r=>`<div class="importRow"><strong>${esc(r.name)}</strong><span class="audit-ok">أضيفت ${r.matched} شعبة</span><span>مكررة ${r.duplicates}</span>${r.unmatched?`<span class="audit-warning">لم تُطابق ${r.unmatched} خانة</span>`:""}</div>`).join("");
  toast(`تمت إضافة ${added.length} شعبة من ${selected.length} ملف`);
}
async function importExamSchedule(file){return importExamSchedules([file]);}

const hijriFormatter=new Intl.DateTimeFormat("en-u-ca-islamic-umalqura",{year:"numeric",month:"2-digit",day:"2-digit",timeZone:"UTC"});
const calendarCache=new Map();
function hijriFromTime(time){const parts=Object.fromEntries(hijriFormatter.formatToParts(new Date(time)).map(p=>[p.type,p.value]));return `${parts.year}/${parts.month}/${parts.day}`;}
function calendarTime(value){
  const raw=westernDigits(value).trim().replace(/[.\-]/g,"/"),m=raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if(!m)return null;
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  if(year>=1700){const t=Date.UTC(year,month-1,day),d=new Date(t);return d.getUTCMonth()===month-1&&d.getUTCDate()===day?t:null;}
  const target=hijriDate(raw);if(!target)return null;
  if(calendarCache.has(target))return calendarCache.get(target);
  const estimated=Math.floor(622+year*0.970224);let low=Math.floor(Date.UTC(estimated-1,0,1)/86400000),high=Math.floor(Date.UTC(estimated+2,11,31)/86400000);
  while(low<=high){const middle=Math.floor((low+high)/2),time=middle*86400000,found=hijriFromTime(time);if(found===target){calendarCache.set(target,time);return time;}if(found<target)low=middle+1;else high=middle-1;}
  return null;
}
function importedCalendar(exams){
  const entries=exams.filter(e=>e.date).map(e=>({exam:e,time:calendarTime(e.date)}));
  if(entries.some(e=>e.time===null))throw new Error("يوجد تاريخ غير صالح في جدول الاختبارات. لم يُضف أي ملف.");
  if(!entries.length)return null;
  entries.sort((a,b)=>a.time-b.time);const first=entries[0],firstIndex=AR_DAYS.indexOf(first.exam.day);
  const start=first.time-(firstIndex>=0?firstIndex:new Date(first.time).getUTCDay())*86400000;
  const enabled=new Set();
  for(const entry of entries){const offset=Math.round((entry.time-start)/86400000),week=Math.floor(offset/7)+1,index=offset%7;
    if(week>4||index>4||offset<0)throw new Error("تواريخ الاختبارات تتجاوز الأسابيع الأربعة أو تتضمن يومًا خارج الأحد إلى الخميس. راجع الجدول قبل الاستيراد.");
    const day=AR_DAYS[index];if(entry.exam.day&&norm(entry.exam.day)!==norm(day))throw new Error(`اليوم والتاريخ غير متوافقين: ${entry.exam.day} ${entry.exam.date}. راجع الملف قبل الاستيراد.`);
    enabled.add(`${week}|${day}`);
  }
  return {days:Array.from({length:20},(_,i)=>{const week=Math.floor(i/5)+1,index=i%5,day=AR_DAYS[index];return {week,day,date:hijriFromTime(start+((week-1)*7+index)*86400000),active:enabled.has(`${week}|${day}`)};}),periods:new Set(exams.map(e=>Number(e.period)))};
}
function applyImportedCalendar(calendar){
  state.days=calendar.days.map(calculated=>({id:state.days.find(d=>d.week===calculated.week&&d.day===calculated.day)?.id||uid("day"),...calculated}));
  for(const period of state.periods)period.active=calendar.periods.has(Number(period.id));
  state.meta.calendarRevision=2;
}
function syncStoredCalendar(){
  if(state.meta.calendarRevision===2||!state.exams.length)return "";
  try{const calendar=importedCalendar(state.exams);if(calendar)applyImportedCalendar(calendar);return "";}catch(error){return `استعيدت بياناتك، لكن تعذر حساب الأيام تلقائيًا: ${error.message}`;}
}

function buildCandidates(code) {
  const m=fieldMap(state.ss01Headers), unique=new Map();
  for(const r of state.ss01) {
    if(!rowIncluded(r,m) || norm(r[m.code])!==norm(code))continue;
    const section=String(r[m.section]||"").trim();if(!section)continue;
    if(!unique.has(norm(section)))unique.set(norm(section),{
      section,course:String(r[m.course]||"").trim(),code,
      dept:String(r[m.dept]||"").trim(),courseTrainer:String(r[m.trainer]||"").trim()
    });
  }
  return [...unique.values()].sort((a,b)=>a.courseTrainer.localeCompare(b.courseTrainer,"ar")||a.section.localeCompare(b.section,"ar",{numeric:true}));
}
function renderBuilder() {
  const m=fieldMap(state.ss01Headers),codeEl=$("#buildCode"),old=codeEl.value;
  const scheduledSections=new Set(eligibleExams().map(e=>norm(e.section))),usedCodes=new Set(state.exams.filter(e=>scheduledSections.has(norm(e.section))).map(e=>norm(e.courseCode||eligibleSections().get(norm(e.section))?.code)).filter(Boolean));
  const codes=[...new Set(state.ss01.filter(r=>rowIncluded(r,m)).map(r=>String(r[m.code]||"").trim()).filter(c=>c&&!usedCodes.has(norm(c))))].sort((a,b)=>a.localeCompare(b,"ar",{numeric:true}));
  codeEl.innerHTML=`<option value="">— اختر رمز المقرر —</option>`+codes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");codeEl.value=old;
  const w=$("#buildWeek"),wo=w.value||"1";w.innerHTML=[1,2,3,4].map(n=>`<option value="${n}">الأسبوع ${n}</option>`).join("");w.value=wo;
  const p=$("#buildPeriod"),po=p.value||"1";p.innerHTML=state.periods.filter(x=>x.active).map(x=>`<option value="${x.id}">${esc(x.name)} — ${esc(x.time)}</option>`).join("");p.value=po;
  syncBuilderDate();previewBuilder();
}
function syncBuilderDate(){
  const daySelect=$("#buildDay"),dateSelect=$("#buildDate"),oldDay=daySelect.value;
  const days=state.days.filter(d=>d.week===Number($("#buildWeek").value)&&d.active&&d.date);
  daySelect.innerHTML=days.map(d=>`<option value="${esc(d.day)}">${esc(d.day)}</option>`).join("")||'<option value="">لا توجد أيام مفعلة</option>';
  if(days.some(d=>d.day===oldDay))daySelect.value=oldDay;
  const day=days.find(d=>d.day===daySelect.value);
  dateSelect.innerHTML=days.map(d=>`<option value="${esc(d.date)}">${esc(displayDate(d.date))}</option>`).join("")||'<option value="">لا يوجد تاريخ</option>';
  if(day)dateSelect.value=day.date;
}
function previewBuilder(){const list=buildCandidates($("#buildCode").value);$("#buildTable tbody").innerHTML=list.map(r=>`<tr><td><input type="checkbox" data-section="${esc(r.section)}" checked></td><td>${esc(r.courseTrainer)}</td><td>${esc(r.section)}</td><td>${esc(r.course)}</td><td>${esc(r.dept)}</td></tr>`).join("");$("#buildInfo").textContent=list.length?`${list.length} شعبة مميزة؛ راجع التحديد قبل الإضافة.`:"اختر رمز مقرر موجودًا في SS01.";$("#buildSelectAll").checked=!!list.length;}
function addBuiltExams(){
  const date=hijriDate($("#buildDate").value);if(!date)return alert("اختر أسبوعًا ويومًا مفعّلًا له تاريخ في الأيام والفترات");
  const week=Number($("#buildWeek").value),day=$("#buildDay").value,period=Number($("#buildPeriod").value),code=$("#buildCode").value;
  if(!code||!period)return alert("اختر رمز المقرر والفترة");
  const selected=new Set($$("#buildTable [data-section]:checked").map(x=>x.dataset.section)),dayRow=state.days.find(d=>d.week===week&&d.day===day);
  if(!selected.size)return alert("حدد شعبة واحدة على الأقل");
  if(dayRow){dayRow.date=date;dayRow.active=true;}
  let added=0;for(const r of buildCandidates(code)){
    if(!selected.has(r.section)||state.exams.some(e=>norm(e.section)===norm(r.section)))continue;
    state.exams.push({id:uid("ex"),week,day,date,period,time:state.periods.find(p=>p.id===period)?.time||"",course:r.course,courseCode:code,section:r.section,dept:r.dept,courseTrainer:r.courseTrainer,room:"",inv1:"",inv2:"",pinned:false,notes:""});added++;
  }
  saveSoon();renderAll();toast(`أُضيفت ${added} شعبة، وتُخطيت المكررات`);
}

function buildingOfRoom(room){const digits=roomCode(room);return digits?digits.slice(3,5):"";}
function sectionDepartmentBuildings(){
  const m=fieldMap(state.ss01Headers),roomLookup=new Map(state.rooms.map(r=>[norm(r.original),r])),votes=new Map();
  for(const row of state.ss01){const dept=norm(row[m.dept]),room=roomLookup.get(norm(row[m.room])),building=room&&buildingOfRoom(room);if(!dept||!building)continue;const counts=votes.get(dept)||new Map();counts.set(building,(counts.get(building)||0)+1);votes.set(dept,counts);}
  const best=new Map();for(const [dept,counts] of votes)best.set(dept,[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0]);return best;
}
function assignRooms(){
  const unique=new Map();for(const r of state.rooms){const code=roomCode(r);if(code&&r.enabled!==false&&!unique.has(code))unique.set(code,r);}
  const rooms=[...unique.values()],preferred=sectionDepartmentBuildings(),occupancy=new Set(),trainerBuildings=new Map();let repaired=0;
  for(const e of eligibleExams()){if(!e.room)continue;const room=roomRecord(e.room),code=roomCode(room),key=`${slotKey(e)}|${code}`;
    if(e.pinned){if(code)occupancy.add(key);continue;}
    if(!code||!unique.has(code)||occupancy.has(key)){e.room="";repaired++;continue;}
    e.room=formatRoom(code);occupancy.add(key);
    if(e.courseTrainer)trainerBuildings.set(`${dayKey(e)}|${norm(e.courseTrainer)}`,buildingOfRoom(room));
  }
  let added=0,missing=0;
  const pending=eligibleExams().filter(e=>!e.room).sort((a,b)=>slotKey(a).localeCompare(slotKey(b))||a.courseTrainer.localeCompare(b.courseTrainer,"ar"));
  for(const e of pending){const preferredBuilding=preferred.get(norm(e.dept))||"",trainerBuilding=trainerBuildings.get(`${dayKey(e)}|${norm(e.courseTrainer)}`)||"";
    const available=rooms.filter(r=>!occupancy.has(`${slotKey(e)}|${roomCode(r)}`));
    available.sort((a,b)=>{
      const score=r=>{const building=buildingOfRoom(r);return (preferredBuilding&&building===preferredBuilding?0:1)*10+(trainerBuilding&&building===trainerBuilding?0:1);};
      return score(a)-score(b)||a.name.localeCompare(b.name,"ar",{numeric:true});
    });
    const choice=available[0];if(!choice){missing++;continue;}
    e.room=formatRoom(choice.original);occupancy.add(`${slotKey(e)}|${roomCode(choice)}`);if(e.courseTrainer)trainerBuildings.set(`${dayKey(e)}|${norm(e.courseTrainer)}`,buildingOfRoom(choice));added++;
  }
  saveSoon();if(typeof document!=="undefined"){renderSchedule();runAudit();toast(`أُسندت ${added} قاعة؛ المتبقي ${missing}؛ صُححت ${repaired} قيمة`);}return {added,missing,repaired};
}

function trainerAvailable(t, ex) {
  const availability=state.availability[t.key]||{},keys=new Set([dayKey(ex),ex.date,`${ex.week||""}-${ex.day}`]);
  for(const d of state.days)if(d.date&&westernDigits(d.date)===westernDigits(ex.date))keys.add(`${d.week}-${d.day}`);
  for(const key of keys)if(key&&(availability[`${key}|${ex.period}`]==="X"||availability[`${key}|ALL`]==="X"))return false;
  return true;
}
function activeTrainer(t){return t.active!==false && String(t.active).toUpperCase()!=="X";}
function assignmentsFor(name){return eligibleExams().flatMap(e=>[e.inv1,e.inv2].map(n=>({n,e}))).filter(x=>x.n===name).map(x=>x.e);}
function wouldMakeThree(name, ex) { const ps=new Set(assignmentsFor(name).filter(e=>dayKey(e)===dayKey(ex)).map(e=>Number(e.period)));ps.add(Number(ex.period));return ps.has(1)&&ps.has(2)&&ps.has(3); }
function hasGapPair(name, ex) { const ps=assignmentsFor(name).filter(e=>dayKey(e)===dayKey(ex)).map(e=>Number(e.period));return ps.length===1&&Math.abs(ps[0]-Number(ex.period))>1; }
function instructorPreviousDay(name, ex) {
  const keys=[...new Set(eligibleExams().map(dayKey).filter(Boolean))];
  const index=keys.indexOf(dayKey(ex));if(index<=0)return false;const prev=keys[index-1];
  return eligibleExams().some(e=>dayKey(e)===prev&&norm(e.courseTrainer)===norm(name));
}
function sameDepartment(t,ex){const wanted=norm(ex.dept);return !!wanted&&String(t.dept||"").split(/[،,]/).some(d=>norm(d)===wanted||norm(d).includes(wanted));}
function courseTrainerConflict(name,exam){return eligibleExams().some(e=>slotKey(e)===slotKey(exam)&&norm(e.courseTrainer)===norm(name));}
function clearOwnExamMonitoring(t){
  if(t.allowOwnExamMonitoring===true)return 0;
  let cleared=0;
  for(const e of eligibleExams())for(const field of ["inv1","inv2"])
    if(norm(e[field])===norm(t.name)&&courseTrainerConflict(t.name,e)){e[field]="";cleared++;}
  return cleared;
}
function clearUnavailableAssignments(){let removed=0;for(const e of state.exams)for(const field of ["inv1","inv2"]){const name=e[field],t=name&&state.trainers.find(x=>norm(x.name)===norm(name));if(name&&(!t||!activeTrainer(t)||!trainerAvailable(t,e))){e[field]="";removed++;}}return removed;}
function removeInactiveAssignments(){return clearUnavailableAssignments();}
function refreshAfterAvailabilityChange(){const removed=clearUnavailableAssignments();saveSoon();renderAvailabilitySummary();renderSchedule();renderReports();runAudit();if(removed)toast(`أُزيل ${removed} إسناد غير متاح؛ الخانة تنتظر مراقبًا`);}
function stripDistributionNote(notes){return String(notes||"").split(/\s*؛\s*/).filter(x=>x&&!/^عجز في المراقبين/.test(x)&&!/^مدرب المقرر .* مفرغ للمتابعة$/.test(x)&&!/^أُلغي تكليف (مراقب بسبب عدم التوفر|مدرب غير نشط)$/.test(x)).join("؛ ");}
function resetMonitors(){let cleared=0;for(const e of state.exams)if(!e.pinned){for(const field of ["inv1","inv2"])if(e[field]){e[field]="";cleared++;}e.notes=stripDistributionNote(e.notes);}saveSoon();if(typeof document!=="undefined"){renderAll();runAudit();toast(`أُزيل ${cleared} إسناد مع إبقاء المثبت`);}return cleared;}
function scoreCandidate(t,ex,counts){let s=(counts[t.name]||0)*100;if(hasGapPair(t.name,ex))s+=12;if(instructorPreviousDay(t.name,ex))s+=18;return s;}
function distributeSlot(exams,counts){
  const blocked=new Set(exams.map(e=>norm(e.courseTrainer)).filter(Boolean));
  const fixedUsed=new Set(exams.flatMap(e=>[e.inv1,e.inv2]).filter(Boolean).map(norm));
  const tasks=exams.flatMap(e=>["inv1","inv2"].filter(f=>!e[f]).map(field=>({ex:e,field})));
  const firstNeeded=tasks.filter(t=>t.field==="inv1").length;
  const all=eligibleExams(),periodsByTrainerDay=new Map(),courseDays=new Map(),days=[...new Set(all.map(dayKey))].sort();
  for(const e of all){for(const name of [e.inv1,e.inv2])if(name){const key=`${norm(name)}|${dayKey(e)}`,ps=periodsByTrainerDay.get(key)||new Set();ps.add(Number(e.period));periodsByTrainerDay.set(key,ps);}
    if(e.courseTrainer){const set=courseDays.get(dayKey(e))||new Set();set.add(norm(e.courseTrainer));courseDays.set(dayKey(e),set);}}
  const three=(name,ex)=>{const ps=periodsByTrainerDay.get(`${norm(name)}|${dayKey(ex)}`)||new Set(),period=Number(ex.period);return [1,2,3].every(p=>p===period||ps.has(p));};
  const candidateScore=(t,ex)=>{const ps=periodsByTrainerDay.get(`${norm(t.name)}|${dayKey(ex)}`)||new Set(),previous=days[days.indexOf(dayKey(ex))-1];return (counts[t.name]||0)*100+(ps.size===1&&Math.abs([...ps][0]-Number(ex.period))>1?12:0)+(previous&&courseDays.get(previous)?.has(norm(t.name))?18:0);};
  const candidateLists=tasks.map(task=>{
    const eligible=state.trainers.filter(t=>activeTrainer(t)&&t.name&&!fixedUsed.has(norm(t.name))&&(!blocked.has(norm(t.name))||t.allowOwnExamMonitoring===true)&&trainerAvailable(t,task.ex)&&(counts[t.name]||0)<num(t.max,999)&&!three(t.name,task.ex));
    const sameCount=eligible.filter(t=>sameDepartment(t,task.ex)).length;
    const reserveSame=task.field==="inv2"&&sameCount<=firstNeeded;
    return eligible.sort((a,b)=>{
      const deptScore=t=>sameDepartment(t,task.ex)?(reserveSame?5:0):(reserveSame?0:5);
      return candidateScore(a,task.ex)+deptScore(a)-candidateScore(b,task.ex)-deptScore(b)||a.name.localeCompare(b.name,"ar");
    });
  });
  // مطابقة قصوى داخل الفترة: إعادة إسناد المرشح تحرر مكانًا لمهمة أخرى بدل ترك خانة ممكنة فارغة.
  const owner=new Map();
  function augment(i,seen){for(const t of candidateLists[i]){const key=norm(t.name);if(seen.has(key))continue;seen.add(key);const previous=owner.get(key);if(previous===undefined||augment(previous,seen)){owner.set(key,i);return true;}}return false;}
  const order=tasks.map((_,i)=>i).sort((a,b)=>candidateLists[a].length-candidateLists[b].length||((tasks[a].field==="inv2")-(tasks[b].field==="inv2")));
  for(const i of order)augment(i,new Set());
  for(const [name,index] of owner){const t=state.trainers.find(x=>norm(x.name)===name);if(!t)continue;tasks[index].ex[tasks[index].field]=t.name;counts[t.name]=(counts[t.name]||0)+1;}
  for(const ex of exams)if(tasks.some(t=>t.ex===ex&&t.field==="inv1")&&tasks.some(t=>t.ex===ex&&t.field==="inv2")&&ex.inv1&&ex.inv2){const first=state.trainers.find(t=>t.name===ex.inv1),second=state.trainers.find(t=>t.name===ex.inv2);if(first&&second&&!sameDepartment(first,ex)&&sameDepartment(second,ex)){[ex.inv1,ex.inv2]=[ex.inv2,ex.inv1];}}
  return owner.size;
}
function distribute(){
  removeInactiveAssignments();
  const working=eligibleExams(),bySlot=new Map();for(const e of working){const key=slotKey(e);if(!bySlot.has(key))bySlot.set(key,[]);bySlot.get(key).push(e);}
  const slots=[...bySlot.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const initial=working.map(e=>[e.inv1||"",e.inv2||""]);
  const attempts=[slots,slots.slice().reverse(),slots.slice().sort((a,b)=>b[1].length-a[1].length||a[0].localeCompare(b[0]))];
  let best=null,bestScore=-Infinity;
  for(const order of attempts){
    working.forEach((e,i)=>{e.inv1=initial[i][0];e.inv2=initial[i][1];});
    const counts=Object.fromEntries(state.trainers.map(t=>[t.name,0]));for(const e of working)for(const n of [e.inv1,e.inv2])if(n)counts[n]=(counts[n]||0)+1;
    for(const [,exams] of order)distributeSlot(exams,counts);
    const filled=working.reduce((n,e)=>n+(e.inv1?1:0)+(e.inv2?1:0),0);
    const deptFirst=working.filter(e=>sameDepartment(state.trainers.find(t=>t.name===e.inv1)||{},e)).length;
    const balance=Object.values(counts).reduce((n,v)=>n+v*v,0);
    const score=filled*100000000-balance*1000+deptFirst;
    if(score>bestScore){bestScore=score;best=working.map(e=>[e.inv1,e.inv2]);}
  }
  working.forEach((e,i)=>{e.inv1=best[i][0];e.inv2=best[i][1];if(!e.pinned)e.notes=stripDistributionNote(e.notes);if(!e.inv1||!e.inv2)e.notes=joinNote(e.notes,"عجز في المراقبين وفق القيود الحالية");});
  const missing=working.filter(e=>!e.inv1||!e.inv2).length;
  saveSoon();if(typeof document!=="undefined"){renderAll();runAudit();toast(`اكتمل التوزيع؛ ${missing} شعبة تحتاج مراجعة`);}
  return missing;
}
function joinNote(a,b){return a?`${a}؛ ${b}`:b;}

function runAudit(){
  const rows=[],seen=new Map(),seenRooms=new Map(),counts={},working=eligibleExams();
  const coursesBySlot=new Map();for(const e of working){const key=slotKey(e),set=coursesBySlot.get(key)||new Set();if(e.courseTrainer)set.add(norm(e.courseTrainer));coursesBySlot.set(key,set);}
  for(const e of working){
    const rowStart=rows.length;
    if(!e.section)rows.push(["خطأ","شعبة ناقصة",`${e.course} — ${e.day}`,"الشعب"]);
    if(!e.room)rows.push(["تحذير","قاعة غير معينة",`${e.course} — شعبة ${e.section}`,"القاعات"]);
    if(e.room){const room=roomRecord(e.room),roomId=roomCode(room);if(!roomId)rows.push(["خطأ","قاعة غير معروفة",`${e.room} — شعبة ${e.section}`,"القاعات"]);
      else if(room.enabled===false)rows.push(["خطأ","قاعة مستبعدة",`${e.room} — شعبة ${e.section}`,"القاعات"]);
      else {const k=`${slotKey(e)}|${roomId}`;if(seenRooms.has(k))rows.push(["خطأ","تعارض قاعة",`${e.room} في ${e.day} الفترة ${e.period}`,"القاعات"]);else seenRooms.set(k,true);}}
    if(!e.inv1||!e.inv2)rows.push(["خطأ",e.inv1||e.inv2?"نقص مراقب":"المراقبان غير معينين",`${e.course} — شعبة ${e.section} — ${e.day} الفترة ${e.period} — ${e.inv1?"مراقب ١ فقط":e.inv2?"مراقب ٢ فقط":"لا يوجد مراقبان"}`,"المدربون"]);
    if(e.inv1&&e.inv1===e.inv2)rows.push(["خطأ","تكرار المراقب",`${e.inv1} في الشعبة ${e.section}`,"المدربون"]);
    for(const n of [e.inv1,e.inv2])if(n){counts[n]=(counts[n]||0)+1;const k=`${slotKey(e)}|${norm(n)}`;if(seen.has(k))rows.push(["خطأ","تعارض مراقب",`${n} في ${e.day} الفترة ${e.period}`,"المدربون"]);else seen.set(k,true);
      const t=state.trainers.find(x=>norm(x.name)===norm(n));if(!t||!activeTrainer(t))rows.push(["خطأ","مدرب غير نشط أو غير معروف",`${n} — شعبة ${e.section}`,"المدربون"]);
      if(t&&!trainerAvailable(t,e))rows.push(["خطأ","مخالفة التفريغ",`${n} في ${e.day} الفترة ${e.period}`,"المدربون"]);
      if(coursesBySlot.get(slotKey(e)).has(norm(n))&&t?.allowOwnExamMonitoring!==true)rows.push(["خطأ","مدرب مقرر لديه اختبار",`${n} في ${e.day} الفترة ${e.period}`,"المدربون"]);
    }
    for(let i=rowStart;i<rows.length;i++)rows[i][4]=e.id;
  }
  for(const t of state.trainers){if((counts[t.name]||0)>num(t.max,999))rows.push(["خطأ","تجاوز الحد الأعلى",`${t.name}: ${counts[t.name]} من ${t.max}`,"المدربون"]);
    const byDay=new Map();for(const e of assignmentsFor(t.name)){const key=dayKey(e),ps=byDay.get(key)||new Set();ps.add(Number(e.period));byDay.set(key,ps);}for(const [key,ps] of byDay)if(ps.has(1)&&ps.has(2)&&ps.has(3))rows.push(["خطأ","ثلاث فترات متتابعة",`${t.name} — ${displayDate(key)}`,"المدربون"]);
  }
  const expected=eligibleSections(),scheduled=new Set(working.map(e=>norm(e.section)).filter(Boolean));
  if(!state.ss01.length)rows.push(["تحذير","بيانات SS01 غير مستوردة","استورد تقرير SS01 أولًا","الشعب"]);
  if(!working.length)rows.push(["تحذير","لم يُبنَ جدول الاختبارات","استورد جدول الاختبارات أو أنشئه من صفحة البناء","الشعب"]);
  for(const [key,item] of expected)if(!scheduled.has(key))rows.push(["تحذير","شعبة غير مجدولة",`${item.course||"مقرر غير مسمى"} (${item.code||"رمز غير محدد"}) — شعبة ${item.section} — النوع: ${item.type||"غير محدد"}`,"الشعب"]);
  auditRows=rows;
  state.auditExceptions??={};
  const current=new Set(rows.map(auditKey));
  for(const key of Object.keys(state.auditExceptions))if(!current.has(key))delete state.auditExceptions[key];
  if(typeof document!=="undefined"){renderAudit();if(!$("#scheduleAuditPanel")?.hidden)renderScheduleAudit();}return rows;
}
function auditKey(row){return JSON.stringify([row[0],row[1],row[2],row[3],row[4]||""]);}
function activeAuditRows(){return auditRows.filter(row=>!state.auditExceptions?.[auditKey(row)]);}

function renderScheduleAudit(){
  const panel=$("#scheduleAuditPanel");if(!panel||panel.hidden)return;
  const active=activeAuditRows(),errors=active.filter(r=>r[0]==="خطأ").length,warnings=active.length-errors;
  const help={"تعارض قاعة":"اختر قاعة أخرى متاحة في الفترة نفسها.","قاعة غير معينة":"عيّن قاعة متاحة للاختبار.","قاعة غير معروفة":"اختر قاعة من قائمة القاعات المعتمدة.","قاعة مستبعدة":"اختر قاعة متاحة أو راجع حالة القاعة.","نقص مراقب":"أكمل خانة المراقب الشاغرة بمدرب متاح.","المراقبان غير معينين":"عيّن مراقبين متاحين للاختبار.","تكرار المراقب":"اختر مدربًا مختلفًا للخانة الثانية.","تعارض مراقب":"غيّر أحد تكليفات المدرب في هذه الفترة.","مخالفة التفريغ":"اختر مدربًا متاحًا أو راجع التفريغ المعتمد.","مدرب غير نشط أو غير معروف":"اختر مدربًا نشطًا من القائمة.","مدرب مقرر لديه اختبار":"اختر مدربًا آخر أو راجع خيار السماح في المدربون.","تجاوز الحد الأعلى":"راجع إجمالي تكليفات المدرب وحدّه الأعلى.","ثلاث فترات متتابعة":"انقل أحد التكليفات إلى مدرب متاح.","شعبة غير مجدولة":"راجع بناء جدول الاختبارات لإضافة الشعبة."};
  panel.innerHTML=`<div class="auditPanelHead"><div><h3>نتيجة فحص الجدول</h3><p>فحص وإرشاد؛ معالجة المشكلات تتم يدويًا.</p></div><button type="button" id="openFullAudit">التفاصيل في التحقق</button></div><div class="auditPills"><span class="audit-error">${errors} أخطاء</span><span class="audit-warning">${warnings} تحذيرات</span><span>${Object.keys(state.auditExceptions||{}).length} استثناءات</span><strong>${esc(auditStatus())}</strong></div>${active.length?`<details open><summary>المشكلات والإرشادات (${active.length})</summary><div class="auditIssueList">${active.map((r,i)=>`<div class="auditIssue"><div><strong class="${r[0]==="خطأ"?"audit-error":"audit-warning"}">${esc(r[1])}</strong><p>${esc(r[2])}</p><small>${esc(help[r[1]]||"راجع البيانات في التبويب المختص.")}</small></div><button type="button" data-issue="${i}">${r[4]?"انتقل إلى الاختبار":"عرض في التحقق"}</button></div>`).join("")}</div></details>`:'<p class="audit-ok">لا توجد أخطاء أو تحذيرات غير مستثناة في الفحوص الحالية.</p>'}`;
  $("#openFullAudit").onclick=()=>$('#tabs button[data-page="audit"]').click();
  for(const button of $$("[data-issue]",panel))button.onclick=()=>{
    const row=active[Number(button.dataset.issue)];if(!row[4])return $('#tabs button[data-page="audit"]').click();
    $("#scheduleSearch").value="";$("#scheduleDayFilter").value="";renderSchedule();
    const tr=$$("#scheduleTable tr[data-id]").find(x=>x.dataset.id===row[4]);
    if(tr){tr.classList.add("auditTarget");tr.scrollIntoView({behavior:"smooth",block:"center"});const field=$("select[data-f=room],select[data-f=inv1],input",tr);field?.focus({preventScroll:true});setTimeout(()=>tr.classList.remove("auditTarget"),5000);}
  };
}
function renderMetrics(){
  const working=eligibleExams(),assigned=working.filter(e=>e.inv1&&e.inv2).length,counts=[
    ["شعب SS01 المؤهلة",eligibleSections().size],["المدربون النشطون",state.trainers.filter(activeTrainer).length],["القاعات",new Set(state.rooms.map(roomCode).filter(Boolean)).size],["الشعب المجدولة",working.length],["مكتملة التوزيع",assigned]
  ];$("#metrics").innerHTML=counts.map(([l,v])=>`<div class="metric"><strong>${v}</strong><span>${l}</span></div>`).join("");
  $("#termLabel").textContent=trainingTermLabel()||"فصل غير محدد";
  $("#ss01Info").textContent=state.meta.ss01Name?`${state.meta.ss01Name} — ${state.meta.ss01ImportedAt}`:"لم يتم الاستيراد";
  const imported=state.meta.examNames?.length?state.meta.examNames.join("، "):state.meta.examName;
  $("#examInfo").textContent=imported?`${imported} — آخر استيراد ${state.meta.examImportedAt}`:"لم يتم الاستيراد";
}
function bindEditable(el, obj, key, parser=v=>v){el.addEventListener("change",()=>{obj[key]=parser(el.type==="checkbox"?el.checked:el.value);saveSoon();});}
function renderTrainers(){const b=$("#trainersTable tbody");b.innerHTML=state.trainers.map(t=>`<tr data-key="${t.key}"><td><input data-f="id" value="${esc(t.id)}"></td><td><textarea data-f="name" rows="2" aria-label="اسم المدرب">${esc(t.name)}</textarea></td><td><textarea data-f="dept" rows="2" aria-label="القسم">${esc(t.dept)}</textarea></td><td><select data-f="active"><option value="true" ${activeTrainer(t)?"selected":""}>متاح</option><option value="false" ${!activeTrainer(t)?"selected":""}>X</option></select></td><td><input type="number" min="0" data-f="max" value="${num(t.max,999)}"></td><td><label><input type="checkbox" data-f="allowOwnExamMonitoring" ${t.allowOwnExamMonitoring===true?"checked":""}> نعم</label></td><td class="source">${esc(t.source)}</td><td><button data-del>حذف</button></td></tr>`).join("");
  const query=norm($("#trainerSearch").value);for(const tr of $$("tr[data-key]",b)){const t=state.trainers.find(x=>x.key===tr.dataset.key);tr.hidden=!!query&&!norm(t.name).includes(query);}
  for(const tr of $$("tr[data-key]",b)){const t=state.trainers.find(x=>x.key===tr.dataset.key);for(const e of $$('[data-f]',tr)){
    if(e.dataset.f==="active")e.onchange=()=>{t.active=e.value==="true";refreshAfterAvailabilityChange();renderTrainers();};
    else if(e.dataset.f==="allowOwnExamMonitoring")e.onchange=()=>{t.allowOwnExamMonitoring=e.checked;const cleared=clearOwnExamMonitoring(t);saveSoon();renderSchedule();renderReports();runAudit();if(cleared)toast(`أُزيل ${cleared} تكليفًا أثناء اختبار مقرر المدرب`);};
    else bindEditable(e,t,e.dataset.f,v=>e.dataset.f==="max"?num(v,999):v);
  }$("[data-del]",tr).onclick=()=>{if(confirm("حذف المدرب؟")){state.trainers=state.trainers.filter(x=>x!==t);saveSoon();renderAll();}};}
}
function fitTrainerTextareas(){for(const input of $$("#trainersTable textarea")){input.style.height="auto";input.style.height=`${Math.max(50,input.scrollHeight+2)}px`;input.oninput=()=>{input.style.height="auto";input.style.height=`${Math.max(50,input.scrollHeight+2)}px`;};}}
function renderRooms(){const b=$("#roomsTable tbody");b.innerHTML=state.rooms.map(r=>`<tr data-key="${r.key}"><td><input type="checkbox" data-enabled ${r.enabled!==false?"checked":""} aria-label="تحديد القاعة"></td><td><input data-f="name" value="${esc(r.name)}"></td><td><input data-f="original" value="${esc(r.original)}"></td><td><input type="number" data-f="capacity" value="${num(r.capacity)}"></td><td class="source">${esc(r.source)}</td><td><button data-del>حذف</button></td></tr>`).join("");const selected=state.rooms.filter(r=>r.enabled!==false).length;$("#selectAllRooms").checked=!!state.rooms.length&&selected===state.rooms.length;$("#selectAllRooms").indeterminate=selected>0&&selected<state.rooms.length;for(const tr of $$("tr[data-key]",b)){const r=state.rooms.find(x=>x.key===tr.dataset.key);const query=norm(westernDigits($("#roomSearch").value));tr.hidden=!!query&&!norm(westernDigits([r.name,r.original].join(" "))).includes(query);$("[data-enabled]",tr).onchange=x=>{r.enabled=x.target.checked;saveSoon();renderRooms();renderSchedule();runAudit();};for(const e of $$('[data-f]',tr))bindEditable(e,r,e.dataset.f,v=>e.dataset.f==="capacity"?num(v):v);$("[data-del]",tr).onclick=()=>{state.rooms=state.rooms.filter(x=>x!==r);saveSoon();renderRooms();renderSchedule();runAudit();};}}
function trainerOptions(selected=""){return `<option value="">— اختر —</option>`+state.trainers.filter(activeTrainer).sort((a,b)=>a.name.localeCompare(b.name,"ar")).map(t=>`<option ${t.name===selected?"selected":""}>${esc(t.name)}</option>`).join("");}
function roomOptions(selected=""){const seen=new Set();return `<option value="">— بدون قاعة —</option>`+state.rooms.filter(r=>{const code=roomCode(r);if(!code||seen.has(code)||r.enabled===false&&validRoomLabel(selected)!==formatRoom(r.original))return false;seen.add(code);return true;}).map(r=>`<option ${validRoomLabel(selected)===formatRoom(r.original)?"selected":""}>${esc(formatRoom(r.original))}</option>`).join("");}
function availabilityDetails(availability){
  return Object.entries(availability||{}).filter(([,v])=>v==="X").sort((a,b)=>a[0].localeCompare(b[0],"ar",{numeric:true})).map(([entry])=>{
    const split=entry.lastIndexOf("|"),key=entry.slice(0,split),period=entry.slice(split+1);
    const day=state.days.find(d=>d.date===key||`${d.week}-${d.day}`===key);
    const date=day?.date?` (${displayDate(day.date)})`:key.match(/^1[34]\d{2}\//)?` (${displayDate(key)})`:"";
    const dayText=day?`الأسبوع ${day.week} — ${day.day}${date}`:displayDate(key);
    const periodText=period==="ALL"?"اليوم كامل":state.periods.find(p=>String(p.id)===period)?.name||`الفترة ${arabicDigits(period)}`;
    return `${dayText}: ${periodText}`;
  });
}
function renderAvailabilitySummary(){
  const tbody=$("#availabilitySummary tbody");
  tbody.innerHTML=state.trainers.filter(t=>availabilityDetails(state.availability[t.key]).length).sort((a,b)=>a.name.localeCompare(b.name,"ar")).map(t=>`<tr data-trainer-key="${esc(t.key)}"><td>${esc(t.name)}</td><td><bdi>${esc(t.id||"—")}</bdi></td><td>${availabilityDetails(state.availability[t.key]).map(d=>`<div class="availabilityDetail">${esc(d)}</div>`).join("")}</td><td><label><input type="checkbox" data-pin-availability ${state.availabilityPinned?.[t.key]?"checked":""}> مثبت</label></td></tr>`).join("")||'<tr><td colspan="4">لا يوجد مدربون مفرغون.</td></tr>';
  for(const row of $$("tr[data-trainer-key]",tbody))$("[data-pin-availability]",row).onchange=e=>{state.availabilityPinned??={};if(e.target.checked)state.availabilityPinned[row.dataset.trainerKey]=true;else delete state.availabilityPinned[row.dataset.trainerKey];saveSoon();};
}
function resetAvailability(){
  let cleared=0;
  for(const key of Object.keys(state.availability)){if(state.availabilityPinned?.[key])continue;cleared+=Object.values(state.availability[key]||{}).filter(v=>v==="X").length;delete state.availability[key];}
  if(typeof document!=="undefined"){refreshAfterAvailabilityChange();renderAvailability();}return cleared;
}
function renderAvailability(){renderAvailabilitySummary();const ts=$("#availabilityTrainer"),old=ts.value;ts.innerHTML=trainerOptions(old);if(!ts.value&&state.trainers[0])ts.value=state.trainers[0].name;const ws=$("#availabilityWeek"),ow=ws.value||"1";ws.innerHTML=[1,2,3,4].map(w=>`<option value="${w}" ${String(w)===ow?"selected":""}>الأسبوع ${w}</option>`).join("");const t=state.trainers.find(x=>x.name===ts.value),week=Number(ws.value);if(!t){$("#availabilityGrid").innerHTML="";return;}const days=state.days.filter(d=>d.week===week);$("#availabilityGrid").innerHTML=days.map(d=>{const dk=d.date||`${d.week}-${d.day}`,all=state.availability[t.key]?.[`${dk}|ALL`]==="X";return `<div class="dayCard"><div class="dayTitle"><span>${esc(d.day)} ${d.date?`— ${esc(d.date)}`:""}</span><label><input type="checkbox" data-day="${esc(dk)}" ${all?"checked":""}> X اليوم كامل</label></div><div class="slots">${state.periods.map(p=>{const checked=all||state.availability[t.key]?.[`${dk}|${p.id}`]==="X";return `<label class="slot"><input type="checkbox" data-slot="${esc(dk)}|${p.id}" ${checked?"checked":""} ${all?"disabled":""}> X — ${esc(p.name)}<small><br>${esc(p.time)}</small></label>`}).join("")}</div></div>`}).join("");for(const e of $$('[data-day]'))e.onchange=()=>{state.availability[t.key]??={};const k=`${e.dataset.day}|ALL`;if(e.checked)state.availability[t.key][k]="X";else delete state.availability[t.key][k];refreshAfterAvailabilityChange();renderAvailability();};for(const e of $$('[data-slot]'))e.onchange=()=>{state.availability[t.key]??={};if(e.checked)state.availability[t.key][e.dataset.slot]="X";else delete state.availability[t.key][e.dataset.slot];refreshAfterAvailabilityChange();};}
function renderPeriods(){
  $("#periodEditor").innerHTML=state.periods.map(p=>`<div class="periodRow"><input type="checkbox" data-active="${p.id}" ${p.active?"checked":""}><input data-name="${p.id}" value="${esc(p.name)}"><input data-time="${p.id}" value="${esc(p.time)}"></div>`).join("");
  for(const p of state.periods){bindEditable($(`[data-active="${p.id}"]`),p,"active");bindEditable($(`[data-name="${p.id}"]`),p,"name");$(`[data-time="${p.id}"]`).onchange=e=>{p.time=e.target.value;saveSoon();renderSchedule();renderReports();renderAnnouncement();renderBuilder();};}
  $("#dayEditor").innerHTML=[1,2,3,4].map(w=>`<div class="weekHeading"><label><input type="checkbox" data-week="${w}" ${state.days.filter(d=>d.week===w).every(d=>d.active)?"checked":""}> تحديد الأسبوع ${w}</label></div>`+state.days.filter(d=>d.week===w).map(d=>`<div class="dayRow"><input type="checkbox" data-da="${d.id}" ${d.active?"checked":""}><span>أ${d.week} — ${esc(d.day)}</span><input type="text" inputmode="numeric" dir="ltr" placeholder="١٤٤٨/٠٨/٢٢" data-dd="${d.id}" value="${esc(displayDate(d.date))}"><span>هجري: سنة/شهر/يوم</span></div>`).join("")).join("");
  $("#selectAllDays").checked=state.days.every(d=>d.active);
  for(const d of state.days){$(`[data-da="${d.id}"]`).onchange=e=>{d.active=e.target.checked;saveSoon();renderPeriods();renderBuilder();};$(`[data-dd="${d.id}"]`).onchange=e=>{const value=e.target.value.trim(),parsed=value?hijriDate(value):"";if(value&&!parsed){alert("التاريخ الهجري يجب أن يكون مثل ١٤٤٨/٠٨/٢٢");e.target.value=displayDate(d.date);return;}d.date=parsed;refreshAfterAvailabilityChange();renderBuilder();renderSchedule();renderAvailability();renderAnnouncement();};}
  for(const el of $$("[data-week]"))el.onchange=()=>{state.days.filter(d=>d.week===Number(el.dataset.week)).forEach(d=>d.active=el.checked);saveSoon();renderPeriods();renderBuilder();};
}
function renderSchedule(){
  const q=norm($("#scheduleSearch").value),df=$("#scheduleDayFilter").value,working=eligibleExams(),days=[...new Set(working.map(e=>e.day).filter(Boolean))];
  $("#scheduleDayFilter").innerHTML=`<option value="">كل الأيام</option>`+days.map(d=>`<option ${d===df?"selected":""}>${esc(d)}</option>`).join("");
  const list=working.filter(e=>(!df||e.day===df)&&(!q||norm([e.course,e.section,e.courseTrainer,e.inv1,e.inv2].join(" ")).includes(q)));
  $("#scheduleTable tbody").innerHTML=list.map(e=>`<tr data-id="${e.id}"><td><input data-f="day" value="${esc(e.day)}"></td><td><input data-f="date" dir="ltr" value="${esc(displayDate(e.date))}"></td><td><select data-f="period">${state.periods.map(p=>`<option value="${p.id}" ${Number(e.period)===p.id?"selected":""}>${p.id}</option>`).join("")}</select></td><td class="scheduleTime"><bdi>${esc(periodTime(e))}</bdi></td><td>${esc(e.course)}</td><td><input data-f="section" value="${esc(e.section)}"></td><td>${esc(e.dept)}</td><td>${esc(e.courseTrainer)}</td><td><select data-f="room">${roomOptions(e.room)}</select></td><td><select data-f="inv1">${trainerOptions(e.inv1)}</select></td><td><select data-f="inv2">${trainerOptions(e.inv2)}</select></td><td><input type="checkbox" data-f="pinned" ${e.pinned?"checked":""}></td><td><div class="autoNotes ${scheduleNotes(e)==="مكتمل"?"note-ok":"note-alert"}" aria-live="polite">${esc(scheduleNotes(e))}</div></td><td><button data-del>حذف</button></td></tr>`).join("");
  for(const tr of $$("tr[data-id]",$("#scheduleTable"))){const e=state.exams.find(x=>x.id===tr.dataset.id);for(const x of $$('[data-f]',tr)){
    if(x.dataset.f==="date")x.onchange=()=>{const v=x.value.trim(),parsed=v?hijriDate(v):"";if(v&&!parsed){alert("أدخل التاريخ الهجري مثل ١٤٤٨/٠٨/٢٢");x.value=displayDate(e.date);return;}e.date=parsed;refreshAfterAvailabilityChange();renderSchedule();};
    else if(["day","period"].includes(x.dataset.f))x.onchange=()=>{e[x.dataset.f]=x.dataset.f==="period"?num(x.value,1):x.value;refreshAfterAvailabilityChange();renderSchedule();};
    else if(["inv1","inv2"].includes(x.dataset.f))x.onchange=()=>{const t=state.trainers.find(t=>t.name===x.value);if(t&&!trainerAvailable(t,e)){alert("هذا المدرب مفرغ في هذه الفترة");x.value=e[x.dataset.f];return;}if(t&&t.allowOwnExamMonitoring!==true&&courseTrainerConflict(t.name,e)){alert("مدرب المقرر لديه اختبار في الفترة نفسها. فعّل خيار السماح من تبويب المدربون أولًا.");x.value=e[x.dataset.f];return;}e[x.dataset.f]=x.value;saveSoon();renderSchedule();renderReports();runAudit();};
    else if(x.dataset.f==="room")x.onchange=()=>{e.room=x.value;saveSoon();renderSchedule();renderReports();runAudit();};
    else bindEditable(x,e,x.dataset.f,v=>x.dataset.f==="pinned"?Boolean(v):v);
  }$("[data-del]",tr).onclick=()=>{state.exams=state.exams.filter(x=>x!==e);saveSoon();renderSchedule();runAudit();};}
  fitScheduleSelections();
}
function fitScheduleSelections(){
  for(const select of $$("#scheduleTable select[data-f]")){
    if(select.dataset.f==="period")continue;
    const wrapper=document.createElement("div");wrapper.className="wrappedSelect";
    const label=document.createElement("span");label.className="selectionLabel";label.setAttribute("aria-hidden","true");
    select.parentNode.insertBefore(wrapper,select);wrapper.append(label,select);
    const update=()=>{label.textContent=select.selectedOptions[0]?.textContent||"اختر";select.setAttribute("aria-label",`${select.dataset.f==="room"?"القاعة":select.dataset.f==="inv1"?"المراقب الأول":"المراقب الثاني"}: ${label.textContent}`);};
    update();select.addEventListener("change",update);
  }
}
function countAssignments(){const c={};for(const e of eligibleExams())for(const n of [e.inv1,e.inv2])if(n)c[n]=(c[n]||0)+1;return c;}
function monitoringReportHtml(){
  const rows=eligibleExams().slice().sort((a,b)=>dayKey(a).localeCompare(dayKey(b),"ar",{numeric:true})||Number(a.period)-Number(b.period)||String(a.room||"").localeCompare(String(b.room||""),"ar",{numeric:true}));
  if(!rows.length)return '<div class="card">لا توجد اختبارات لعرض جدول المراقبة.</div>';
  return `<section class="monitoringSheet"><h2>جدول المراقبة</h2><p class="monitoringCount">عدد الاختبارات: ${arabicDigits(rows.length)}</p><table><colgroup><col style="width:10%"><col style="width:12%"><col style="width:12%"><col style="width:16%"><col style="width:15%"><col style="width:15%"><col style="width:20%"></colgroup><thead><tr><th>اليوم</th><th>التاريخ</th><th>الفترة</th><th>القاعة</th><th>المراقب الأول</th><th>المراقب الثاني</th><th>ملاحظات</th></tr></thead><tbody>${rows.map(e=>{
    const period=state.periods.find(p=>Number(p.id)===Number(e.period))?.name||`الفترة ${arabicDigits(e.period)}`;
    const notes=[scheduleNotes(e),stripDistributionNote(e.notes)].filter(v=>v&&v!=="مكتمل").join("؛ ")||"—";
    return `<tr><td>${esc(e.day||"—")}</td><td class="dateValue"><bdi>${esc(displayDate(e.date)||"—")}</bdi></td><td>${esc(period)}</td><td>${esc(validRoomLabel(e.room)||"غير محددة")}</td><td>${esc(e.inv1||"غير معيّن")}</td><td>${esc(e.inv2||"غير معيّن")}</td><td>${esc(notes)}</td></tr>`;
  }).join("")}</tbody></table></section>`;
}
function renderReports(){const sel=$("#reportTrainer"),old=sel.value;sel.innerHTML=trainerOptions(old);const c=countAssignments(),active=state.trainers.filter(activeTrainer).sort((a,b)=>a.name.localeCompare(b.name,"ar"));if(!sel.value){const first=active.find(t=>c[t.name]);if(first)sel.value=first.name;}const total=active.reduce((sum,t)=>sum+(c[t.name]||0),0),average=active.length?total/active.length:0;$("#trainerAverage").textContent=`متوسط المراقبات: ${average.toFixed(2)} لكل مدرب نشط (${total} مراقبة ÷ ${active.length} مدرب)`;$("#trainerCounts").innerHTML=active.map(t=>`<div class="countRow"><span>${esc(t.name)}</span><strong>${c[t.name]||0}</strong></div>`).join("")||"لا يوجد مدربون نشطون";$("#monitoringReportPreview").innerHTML=monitoringReportHtml();renderReportPreview(sel.value?[sel.value]:[]);}
function trainerSheet(name){
  const t=state.trainers.find(x=>x.name===name),rows=eligibleExams().filter(e=>e.inv1===name||e.inv2===name).sort((a,b)=>dayKey(a).localeCompare(dayKey(b))||a.period-b.period);
  if(!rows.length)return"";
  return `<section class="trainerSheet"><h2>جدول مراقبات المدرب</h2><div class="trainerMeta"><span><strong>الاسم:</strong> ${esc(name)}</span><span><strong>الرقم الوظيفي:</strong> <bdi>${esc(t?.id||"")}</bdi></span><span><strong>القسم:</strong> ${esc(t?.dept||"")}</span></div><table><colgroup><col style="width:9%"><col style="width:11%"><col style="width:6%"><col style="width:10%"><col style="width:19%"><col style="width:8%"><col style="width:18%"><col style="width:19%"></colgroup><thead><tr><th>اليوم</th><th>التاريخ</th><th>الفترة</th><th>الوقت</th><th>المقرر</th><th>الشعبة</th><th>القاعة</th><th>ملاحظات</th></tr></thead><tbody>${rows.map(e=>{
    const time=periodTime(e);
    const notes=[scheduleNotes(e),stripDistributionNote(e.notes)].filter(v=>v&&v!=="مكتمل").join("؛ ")||"—";
    return `<tr><td>${esc(e.day)}</td><td class="dateValue"><bdi>${esc(displayDate(e.date))}</bdi></td><td>${esc(e.period)}</td><td class="timeValue"><bdi>${esc(time)}</bdi></td><td>${esc(e.course)}</td><td><bdi>${esc(e.section)}</bdi></td><td>${esc(validRoomLabel(e.room)||"غير محددة")}</td><td>${esc(notes)}</td></tr>`;
  }).join("")}</tbody></table><p class="trainerReminder">حضورك قبل بداية الاختبار بـ 15 دقيقة يسهم في تنظيم أعمال اللجنة.</p></section>`;
}
function renderReportPreview(names){$("#reportPreview").innerHTML=names.map(trainerSheet).join("");}
function announcementInstructionsHtml(){
  const text=(state.meta.announcementInstructions||"").trim();
  return text?`<tfoot><tr><td colspan="9" class="instructionsCell"><div class="examInstructions"><h3>تعليمات الاختبار</h3><div>${esc(text)}</div></div></td></tr></tfoot>`:"";
}
function announcementSheets(onlyDate=""){
  const sections=eligibleSections(),groups=new Map();
  for(const e of eligibleExams()){
    if(onlyDate&&westernDigits(e.date)!==westernDigits(onlyDate))continue;
    const period=Number(e.period);if(!Number.isInteger(period)||period<1)continue;
    const key=`${dayKey(e)}|${e.day||""}`;
    if(!groups.has(key))groups.set(key,{day:e.day||"غير محدد",date:e.date||"",rows:[]});
    groups.get(key).rows.push(e);
  }
  const ordered=[...groups].sort((a,b)=>a[0].localeCompare(b[0],"ar",{numeric:true}));
  return ordered.map(([,group])=>{
    const rows=group.rows.sort((a,b)=>Number(a.period)-Number(b.period)||String(a.course).localeCompare(String(b.course),"ar")||String(a.section).localeCompare(String(b.section),"ar",{numeric:true}));
    const cells=rows.map(e=>{
      const p=state.periods.find(x=>Number(x.id)===Number(e.period)),code=e.courseCode||sections.get(norm(e.section))?.code||"—";
      const time=periodTime(e),room=validRoomLabel(e.room)||"لم تُحدد القاعة";
      return `<tr><td>${esc(group.day)}</td><td class="ltrCell"><bdi>${esc(displayDate(e.date)||"غير محدد")}</bdi></td><td>${esc(p?.name||`الفترة ${arabicDigits(e.period)}`)}</td><td class="ltrCell"><bdi>${esc(time)}</bdi></td><td>${esc(e.course||"—")}</td><td class="ltrCell"><bdi>${esc(code)}</bdi></td><td class="ltrCell"><bdi>${esc(e.section||"—")}</bdi></td><td>${esc(e.courseTrainer||"—")}</td><td class="${room==='لم تُحدد القاعة'?'missingRoom':''}">${esc(room)}</td></tr>`;
    }).join("");
    return `<section class="announcementSheet"><div class="announcementBrand">الكلية التقنية التطبيقية بالرياض</div><h2>جدول الاختبارات للمتدربين</h2>${state.meta.announcementTerm?.trim()?`<p class="announcementTerm">الفصل التدريبي: ${esc(state.meta.announcementTerm.trim())}</p>`:""}<table><thead><tr><th>اليوم</th><th>التاريخ</th><th>الفترة</th><th>التوقيت</th><th>المقرر</th><th>رمز المقرر</th><th>رقم الشعبة</th><th>اسم المدرب</th><th>القاعة</th></tr></thead><tbody>${cells}</tbody>${announcementInstructionsHtml()}</table><p class="announcementFoot">يرجى التأكد من اليوم والتاريخ والقاعة قبل الاختبار.</p></section>`;
  }).join("");
}
function renderAnnouncement(){
  $("#announcementTerm").value=state.meta.announcementTerm||"";
  $("#announcementInstructions").value=state.meta.announcementInstructions||"";
  const daySelect=$("#announcementDate"),old=daySelect.value,dates=new Map();
  for(const e of eligibleExams())if(e.date)dates.set(westernDigits(e.date),`${e.day||"اليوم"} — ${displayDate(e.date)}`);
  daySelect.innerHTML='<option value="">اختر التاريخ</option>'+[...dates].sort((a,b)=>a[0].localeCompare(b[0],"ar",{numeric:true})).map(([date,label])=>`<option value="${esc(date)}">${esc(label)}</option>`).join("");
  if(dates.has(old))daySelect.value=old;
  const html=announcementSheets();
  $("#announcementPreview").innerHTML=html||'<div class="card">لا توجد اختبارات مجدولة.</div>';
  const days=(html.match(/class="announcementSheet"/g)||[]).length;
  $("#announcementInfo").textContent=days?`${days} أيام في المعاينة؛ كل يوم يبدأ في صفحة جديدة عند الطباعة.`:"لا توجد اختبارات مجدولة.";
}
const announcementPrintCss=`@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;direction:rtl;color:#172033;margin:0;background:#fff}.announcementSheet{break-before:page;page-break-before:always}.announcementSheet:first-of-type{break-before:auto;page-break-before:auto}.announcementBrand{color:#14746f;font-weight:700;font-size:12px}.announcementSheet h2{text-align:center;color:#103e40;margin:5px 0;font-size:22px}.announcementTerm{text-align:center;margin:3px 0 12px;color:#52657b}.announcementDay{display:flex;justify-content:space-between;align-items:center;background:#e8f3ed;border-right:5px solid #14746f;padding:9px 13px;margin:14px 0;font-size:16px}.announcementDay bdi{direction:ltr;unicode-bidi:isolate}.announcementSheet table{width:100%;border-collapse:collapse;table-layout:auto;font-size:11px}.announcementSheet thead{display:table-header-group}.announcementSheet th,.announcementSheet td{border:1px solid #b8c8d5;padding:6px 5px;text-align:right;vertical-align:middle;overflow-wrap:anywhere}.announcementSheet th{background:#103e40;color:#fff}.announcementSheet tbody tr:nth-child(even){background:#f2f7fa}.announcementSheet tr{break-inside:avoid;page-break-inside:avoid}.ltrCell bdi{direction:ltr;unicode-bidi:isolate}.missingRoom{color:#a33a26;font-weight:700}.announcementFoot{font-size:10px;color:#607086;margin:12px 0}.announcementSheet th{white-space:nowrap}.announcementSheet td:nth-child(2),.announcementSheet td:nth-child(4),.announcementSheet td:nth-child(6),.announcementSheet td:nth-child(7){white-space:nowrap}.announcementSheet tfoot{display:table-footer-group}.announcementSheet .instructionsCell{border:0;padding:12px 0 0;background:#fff;white-space:normal}.examInstructions{border:1px solid #b9d7d1;border-right:4px solid #159e91;border-radius:9px;padding:10px 14px;background:#f3faf8;break-inside:avoid;page-break-inside:avoid}.examInstructions h3{font-size:13px;color:#103f43;margin:0 0 5px}.examInstructions div{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font-size:11px}.noPrint{padding:10px}@media print{.noPrint{display:none}}`;
function printAnnouncement(onlyDate=""){
  const sheets=announcementSheets(onlyDate);
  if(!sheets)return alert("لا توجد اختبارات مجدولة");
  const win=window.open("","_blank");if(!win)return alert("اسمح بالنوافذ المنبثقة لهذا الملف ثم أعد المحاولة");
  win.document.open();win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>إعلان جدول الاختبارات للمتدربين</title><style>${announcementPrintCss}</style></head><body><div class="noPrint"><button onclick="window.print()">طباعة / حفظ PDF</button></div>${sheets}</body></html>`);win.document.close();win.focus();
  win.addEventListener("load",()=>setTimeout(()=>win.print(),350),{once:true});
}
function auditStatus(rows=activeAuditRows()){const working=eligibleExams(),ready=!!state.ss01.length&&working.length>0&&eligibleSections().size>0&&working.every(e=>e.section&&validRoomLabel(e.room)&&e.inv1&&e.inv2);return rows.some(r=>r[0]==="خطأ")?"يحتاج معالجة":!ready||rows.some(r=>r[0]==="تحذير")?"غير مكتمل":Object.keys(state.auditExceptions||{}).length?"سليم مع استثناءات":"سليم";}
function renderAudit(){
  const active=activeAuditRows(),errors=active.filter(r=>r[0]==="خطأ").length,warnings=active.filter(r=>r[0]==="تحذير").length,exceptions=Object.keys(state.auditExceptions||{}).length;
  $("#auditSummary").innerHTML=[["أخطاء",errors],["تحذيرات",warnings],["استثناءات",exceptions],["حالة الجدول",auditStatus()]].map(([l,v])=>`<div class="metric"><strong class="${l==="أخطاء"&&v?"audit-error":l==="تحذيرات"&&v?"audit-warning":l==="حالة الجدول"?(v==="يحتاج معالجة"?"audit-error":v==="غير مكتمل"?"audit-warning":"audit-ok"):""}">${esc(v)}</strong><span>${l}</span></div>`).join("");
  const category=$("#auditCategory").value,level=$("#auditLevel").value,showExceptions=$("#showAuditExceptions").checked;
  const visible=auditRows.map((row,i)=>({row,i,excepted:!!state.auditExceptions?.[auditKey(row)]})).filter(x=>(!category||x.row[3]===category)&&(!level||x.row[0]===level)&&(showExceptions||!x.excepted));
  $("#auditTable tbody").innerHTML=visible.length?visible.map(({row:r,i,excepted})=>`<tr class="${excepted?"exceptedRow":""}"><td class="audit-${r[0]==="خطأ"?"error":r[0]==="تحذير"?"warning":"ok"}">${esc(excepted?"مستثنى":r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td><button type="button" data-audit-index="${i}">${excepted?"إلغاء الاستثناء":r[0]==="تحذير"?"استثناء التحذير":"استثناء الخطأ"}</button></td></tr>`).join(""):'<tr><td colspan="4">لا توجد نتائج في هذا التصنيف</td></tr>';
  for(const button of $$("#auditTable [data-audit-index]"))button.onclick=()=>{
    const row=auditRows[Number(button.dataset.auditIndex)],key=auditKey(row);
    state.auditExceptions??={};
    if(state.auditExceptions[key])delete state.auditExceptions[key];else state.auditExceptions[key]=true;
    saveSoon();renderAudit();
  };
}
function renderAll(){renderMetrics();renderTrainers();renderRooms();renderAvailability();renderPeriods();renderBuilder();renderSchedule();renderReports();renderAnnouncement();renderAudit();}

function openSimpleForm(title,fields,onSave){const d=$("#editDialog"),box=$("#dialogFields");$("#dialogTitle").textContent=title;box.innerHTML=fields.map(f=>`<label class="field"><span>${esc(f.label)}</span><input name="${esc(f.name)}" type="${f.type||"text"}" value="${esc(f.value||"")}"></label>`).join("");d.returnValue="";d.showModal();$("#dialogSave").onclick=e=>{e.preventDefault();const data=Object.fromEntries(new FormData($("form",d)));onSave(data);d.close();};}
function download(name,content,type="application/json"){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function backupFileName(now=new Date()){
  const header=findHeader(state.ss01Headers||[],[/الفصل التدريبي/,/الفصل/]);
  if(!header||!state.ss01?.length)throw new Error("استورد SS01 الذي يحتوي رمز الفصل قبل تصدير نسخة العمل.");
  const terms=(state.ss01||[]).map(row=>westernDigits(row[header]||"").trim());
  const unique=[...new Set(terms)];
  if(unique.length!==1||!/^\d{3,4}(10|20)$/.test(unique[0]))throw new Error("رمز الفصل في SS01 مفقود أو مختلف بين السجلات. راجع الملف قبل التصدير.");
  const stamp=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
  return `${unique[0]}_${stamp}.json`;
}
function csvCell(value){return `"${String(value??"").replace(/"/g,'""')}"`;}
function portalCsv(){
  const rows=[["الرقم الوظيفي","اسم المدرب","القسم","اليوم","التاريخ","الفترة","الوقت","المقرر","الشعبة","القاعة"]];
  for(const e of eligibleExams())for(const name of new Set([e.inv1,e.inv2].filter(Boolean))){const t=state.trainers.find(x=>x.name===name);if(!t?.id||!activeTrainer(t))continue;
    rows.push([t.id,name,t.dept,e.day,displayDate(e.date),e.period,periodTime(e),e.course,e.section,validRoomLabel(e.room)||"غير محددة"]);
  }
  return "\uFEFF"+rows.map(row=>row.map(csvCell).join(",")).join("\r\n");
}
function printSheets(names){
  const sheets=names.map(trainerSheet).filter(Boolean);if(!sheets.length){alert("لا توجد جداول للمراقبين المحددين");return;}
  const win=window.open("","_blank");if(!win){alert("اسمح بالنوافذ المنبثقة لهذا الملف ثم أعد المحاولة");return;}
  const css=`@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;direction:rtl;color:#172033;margin:0}.trainerSheet{break-after:page;page-break-after:always}.trainerSheet:last-child{break-after:auto;page-break-after:auto}h2{text-align:center;color:#103e40;margin:0 0 12px}.trainerMeta{display:flex;justify-content:space-between;gap:12px;padding:10px;border:1px solid #ccd6e2;margin-bottom:12px}table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11px}th,td{border:1px solid #9aabc0;padding:7px;text-align:right;overflow-wrap:anywhere;vertical-align:top}th{background:#e4f0eb}tr{break-inside:avoid}.trainerReminder{text-align:center;font-weight:700;font-size:13px;margin:14px 0 0;color:#103e40}.dateValue,.timeValue{direction:ltr;text-align:center;white-space:nowrap}.noPrint{margin:10px}@media print{.noPrint{display:none}}`;
  win.document.open();win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>جداول المراقبات</title><style>${css}</style></head><body><div class="noPrint"><button onclick="window.print()">طباعة / حفظ PDF</button></div>${sheets.join("")}</body></html>`);win.document.close();win.focus();
  win.addEventListener("load",()=>setTimeout(()=>win.print(),350),{once:true});
}
function printMonitoringReport(){
  if(!eligibleExams().length)return alert("لا توجد اختبارات لطباعة جدول المراقبة");
  const win=window.open("","_blank");if(!win)return alert("اسمح بالنوافذ المنبثقة لهذا الملف ثم أعد المحاولة");
  const css=`@page{size:A4 landscape;margin:11mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;direction:rtl;color:#172033;margin:0}.monitoringSheet h2{text-align:center;color:#103e40;margin:0 0 5px}.monitoringCount{text-align:center;margin:0 0 12px;color:#52657b}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px}thead{display:table-header-group}th,td{border:1px solid #aabaca;padding:6px;text-align:right;vertical-align:top;overflow-wrap:anywhere}th{background:#e4f0eb}tr{break-inside:avoid;page-break-inside:avoid}.dateValue{direction:ltr;text-align:center;white-space:nowrap}.announcementSheet th{white-space:nowrap}.announcementSheet td:nth-child(2),.announcementSheet td:nth-child(4),.announcementSheet td:nth-child(6),.announcementSheet td:nth-child(7){white-space:nowrap}.announcementSheet tfoot{display:table-footer-group}.announcementSheet .instructionsCell{border:0;padding:12px 0 0;background:#fff;white-space:normal}.examInstructions{border:1px solid #b9d7d1;border-right:4px solid #159e91;border-radius:9px;padding:10px 14px;background:#f3faf8;break-inside:avoid;page-break-inside:avoid}.examInstructions h3{font-size:13px;color:#103f43;margin:0 0 5px}.examInstructions div{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font-size:11px}.noPrint{padding:10px}@media print{.noPrint{display:none}}`;
  win.document.open();win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>جدول المراقبة</title><style>${css}</style></head><body><div class="noPrint"><button onclick="window.print()">طباعة / حفظ PDF</button></div>${monitoringReportHtml()}</body></html>`);win.document.close();win.focus();
  win.addEventListener("load",()=>setTimeout(()=>win.print(),350),{once:true});
}

function bindUi(){
  $("#tabs").onclick=e=>{const b=e.target.closest("button[data-page]");if(!b)return;$$('#tabs button').forEach(x=>x.classList.toggle("active",x===b));$$('.page').forEach(x=>x.classList.toggle("active",x.id===`page-${b.dataset.page}`));if(b.dataset.page==="trainers"){renderTrainers();fitTrainerTextareas();}if(b.dataset.page==="audit")runAudit();if(b.dataset.page==="announcement")renderAnnouncement();if(b.dataset.page==="reports")renderReports();if(b.dataset.page==="schedule")renderSchedule();};
  for(const group of $$(".subtabs"))group.onclick=e=>{const target=e.target.closest("button[data-subtab]");if(!target)return;for(const b of $$("button[data-subtab]",group)){b.classList.toggle("active",b===target);b.setAttribute("aria-selected",b===target?"true":"false");}for(const panel of group.parentElement.querySelectorAll(":scope > .subpanel"))panel.classList.toggle("active",panel.id===target.dataset.subtab);};
  $("#ss01File").onchange=async e=>{try{await importSS01(e.target.files[0]);toast("تم استيراد SS01");}catch(err){alert(err.message);}e.target.value="";};
  $("#examFile").onchange=async e=>{const input=e.target,files=[...input.files];input.disabled=true;try{$("#examImportResult").textContent=`جارٍ فحص ${files.length} ملف…`;await importExamSchedules(files);}catch(err){$("#examImportResult").innerHTML=`<span class="audit-error">${esc(err.message)}</span>`;alert(err.message);}finally{input.value="";input.disabled=false;}};
  $("#buildWeek").onchange=syncBuilderDate;$("#buildDay").onchange=syncBuilderDate;$("#buildCode").onchange=previewBuilder;
  $("#buildDate").onchange=()=>{const day=state.days.find(d=>d.week===Number($("#buildWeek").value)&&d.date===$("#buildDate").value&&d.active);if(day)$("#buildDay").value=day.day;};
  $("#buildAddBtn").onclick=addBuiltExams;
  $("#buildSelectAll").onchange=e=>$$("#buildTable [data-section]").forEach(x=>x.checked=e.target.checked);
  $("#selectAllDays").onchange=e=>{state.days.forEach(d=>d.active=e.target.checked);saveSoon();renderPeriods();renderBuilder();};
  $("#backupBtn").onclick=()=>{try{download(backupFileName(),JSON.stringify(state));}catch(err){alert(err.message);}};
  $("#restoreFile").onchange=async e=>{try{const obj=JSON.parse(await e.target.files[0].text());if(!obj.version)throw new Error("نسخة غير صالحة");state=obj;const calendarWarning=syncStoredCalendar();removeInactiveAssignments();await dbSet(STATE_KEY,state);renderAll();runAudit();toast(calendarWarning||"تم استيراد نسخة العمل");}catch(err){alert(err.message);}e.target.value="";};
  $("#resetBtn").onclick=async()=>{if(confirm("هل تريد تهيئة فصل جديد؟ سيتم تنزيل نسخة احتياطية أولًا.")){download(`نسخة_قبل_التهيئة_${Date.now()}.json`,JSON.stringify(state));state=defaultState();await dbSet(STATE_KEY,state);renderAll();runAudit();}};
  for(const id of ["#scheduleDistributeBtn"])$(id).onclick=distribute;
  for(const id of ["#scheduleResetMonitorsBtn"])$(id).onclick=()=>{if(confirm("إزالة جميع المراقبين من الصفوف غير المثبتة ثم إعادة توزيعهم لاحقًا؟"))resetMonitors();};
  $("#assignRoomsBtn").onclick=assignRooms;
  $("#scheduleAuditBtn").onclick=()=>{const panel=$("#scheduleAuditPanel");panel.hidden=false;runAudit();panel.scrollIntoView({behavior:"smooth",block:"start"});};
  $("#runAuditBtn").onclick=runAudit;
  $("#auditCategory").onchange=renderAudit;$("#auditLevel").onchange=renderAudit;$("#showAuditExceptions").onchange=renderAudit;
  $("#addTrainerBtn").onclick=()=>openSimpleForm("إضافة مدرب",[{name:"id",label:"الرقم الوظيفي"},{name:"name",label:"الاسم"},{name:"dept",label:"القسم"},{name:"max",label:"الحد الأعلى",type:"number",value:"999"}],d=>{state.trainers.push({key:uid("tr"),...d,max:num(d.max,999),active:true,allowOwnExamMonitoring:false,source:"يدوي"});saveSoon();renderAll();});
  $("#addRoomBtn").onclick=()=>openSimpleForm("إضافة قاعة",[{name:"name",label:"اسم القاعة"},{name:"original",label:"الرمز الأصلي"},{name:"capacity",label:"السعة",type:"number"}],d=>{state.rooms.push({key:uid("room"),...d,capacity:num(d.capacity),source:"يدوي"});saveSoon();renderRooms();});
  $("#addExamBtn").onclick=()=>openSimpleForm("إضافة اختبار",[{name:"day",label:"اليوم"},{name:"date",label:"التاريخ الهجري أو الميلادي"},{name:"period",label:"الفترة",type:"number",value:"1"},{name:"course",label:"اسم المقرر"},{name:"section",label:"رقم الشعبة"},{name:"dept",label:"القسم"},{name:"courseTrainer",label:"مدرب المقرر"}],d=>{state.exams.push({id:uid("ex"),...d,period:num(d.period,1),time:"",room:"",inv1:"",inv2:"",pinned:false,notes:""});saveSoon();renderAll();});
  $("#availabilityTrainer").onchange=renderAvailability;$("#availabilityWeek").onchange=renderAvailability;
  $("#resetAvailabilityBtn").onclick=()=>{if(confirm("إزالة جميع حالات التفريغ غير المثبتة؟ سيبقى تفريغ المدربين المثبتين.")){const count=resetAvailability();toast(`أُزيلت ${count} حالة تفريغ غير مثبتة`);}};
  $("#announcementInstructions").oninput=e=>{state.meta.announcementInstructions=e.target.value;saveSoon();$("#announcementPreview").innerHTML=announcementSheets()||'<div class="card">لا توجد اختبارات مجدولة.</div>';};
  $("#announcementTerm").oninput=e=>{state.meta.announcementTerm=e.target.value;saveSoon();$("#announcementPreview").innerHTML=announcementSheets()||'<div class="card">لا توجد اختبارات مجدولة.</div>';};
  $("#scheduleSearch").oninput=renderSchedule;$("#scheduleDayFilter").onchange=renderSchedule;
  $("#reportTrainer").onchange=()=>renderReportPreview([$("#reportTrainer").value]);
  $("#printTrainerBtn").onclick=()=>{const n=$("#reportTrainer").value;if(!n)return alert("اختر مدربًا");renderReportPreview([n]);printSheets([n]);};
  $("#printAllBtn").onclick=()=>{const counts=countAssignments(),names=state.trainers.filter(t=>activeTrainer(t)&&counts[t.name]).map(t=>t.name).sort((a,b)=>a.localeCompare(b,"ar"));renderReportPreview(names);printSheets(names);};
  $("#printMonitoringReportBtn").onclick=printMonitoringReport;
  $("#portalExportBtn").onclick=()=>download("مراقبات_بوابة_المدربين.csv",portalCsv(),"text/csv;charset=utf-8");
  $("#trainerSearch").oninput=renderTrainers;
  $("#roomSearch").oninput=renderRooms;
  $("#selectAllRooms").onchange=e=>{for(const r of state.rooms)r.enabled=e.target.checked;saveSoon();renderRooms();renderSchedule();runAudit();};
  $("#printAnnouncementBtn").onclick=()=>printAnnouncement();
  $("#printAnnouncementDayBtn").onclick=()=>{const date=$("#announcementDate").value;if(!date)return alert("اختر تاريخ اليوم أولًا");printAnnouncement(date);};
}

async function init(){
  try{db=await openDb();state=await dbGet(STATE_KEY)||defaultState();const calendarWarning=syncStoredCalendar();bindUi();removeInactiveAssignments();await dbSet(STATE_KEY,state);renderAll();runAudit();if(calendarWarning)toast(calendarWarning);}
  catch(err){document.body.innerHTML=`<main><div class="card"><h2>تعذر تشغيل النظام</h2><p>${esc(err.message)}</p><p>استخدم Microsoft Edge أو Google Chrome الحديث.</p></div></main>`;}
}

if (typeof document !== "undefined") init();
if (typeof module !== "undefined" && module.exports) module.exports = {
  announcementInstructionsHtml,
  parseCsv, parseXlsx, rowsToObjects, fieldMap, formatRoom, trainingIncluded, periodNo, parseExamMatrix, parseExamSource,
  defaultState, setState: value => { state = value; }, getState: () => state,
  distribute, resetMonitors, removeInactiveAssignments, runAudit, auditStatus, auditKey, activeAuditRows, activeTrainer, trainerAvailable, hijriDate, buildCandidates, eligibleSections, eligibleExams, assignRooms, portalCsv, periodTime, clearUnavailableAssignments, sectionDepartmentBuildings, trainerSheet, announcementSheets, scheduleNotes, trainingTermLabel, availabilityDetails, resetAvailability, courseTrainerConflict, clearOwnExamMonitoring, monitoringReportHtml, backupFileName, prepareExamSchedules, importedCalendar, calendarTime, hijriFromTime
};
