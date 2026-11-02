/* Read-only presentation layer. No writes to state or storage. */
"use strict";
function identityChartData(rows, roomCheck) {
  const status={complete:0,partial:0,empty:0},days=new Map(),departments=new Map();
  for(const e of rows){
    const room=roomCheck(e),both=!!e.inv1&&!!e.inv2&&e.inv1!==e.inv2;
    if(room&&both)status.complete++;else if(room||e.inv1||e.inv2)status.partial++;else status.empty++;
    const key=[e.date||"",e.day||"غير محدد"].join("|");
    if(!days.has(key))days.set(key,{date:e.date||"",day:e.day||"غير محدد",value:0});days.get(key).value++;
    const department=e.dept||"غير محدد";departments.set(department,(departments.get(department)||0)+1);
  }
  return {total:rows.length,status,days:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date,"ar",{numeric:true})),departments:[...departments].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value||a.label.localeCompare(b.label,"ar"))};
}

if(typeof document!=="undefined")(()=>{
  if(!document.getElementById('tabs'))return;
  const paths={
    home:'<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
    guide:'<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4Z"/><path d="M13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2"/>',
    periods:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
    trainers:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',
    rooms:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h2m4 0h2M8 11h2m4 0h2M10 21v-6h4v6"/>',
    availability:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2m-9 3 10-10"/>',
    builder:'<rect x="4" y="4" width="16" height="17" rx="3"/><path d="M8 3v3m8-3v3M8 11h8m-8 4h5"/>',
    schedule:'<path d="M4 5h16v15H4Z"/><path d="M4 10h16M10 5v15m5-5 2 2 3-4"/>',
    reports:'<path d="M4 3h11l5 5v13H4Z"/><path d="M14 3v6h6M8 17v-4m4 4v-6m4 6v-3"/>',
    announcement:'<path d="m3 10 18-6v16L3 14Zm4 5 2 6h4l-2-7"/>',
    audit:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
    bell:'<path d="M6 16V9a6 6 0 0 1 12 0v7l2 2H4Zm4 5h4"/>',
    settings:'<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/><circle cx="12" cy="12" r="5"/>',
    check:'<path d="m5 12 4 4L20 5"/>',
    chart:'<path d="M4 3v18h17M8 17v-5m5 5V7m5 10v-8"/>'
  };
  const icon=(name)=>`<svg class="uiIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.chart}</svg>`;
  const safe=v=>String(v??"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const digits=v=>String(v).replace(/\d/g,d=>'٠١٢٣٤٥٦٧٨٩'[Number(d)]);
  function decorateMetrics(root){
    const names=['schedule','trainers','rooms','periods','check'];
    root?.querySelectorAll('.metric').forEach((card,i)=>{if(!card.querySelector('.metricIcon'))card.insertAdjacentHTML('afterbegin',`<span class="metricIcon">${icon(names[i]||'audit')}</span>`);});
  }
  function updateAlerts(){
    const count=activeAuditRows().filter(r=>r[0]==='خطأ'||r[0]==='تحذير').length;
    const badge=document.getElementById('identityAlertCount');badge.textContent=digits(count);badge.hidden=!count;
    document.getElementById('identityAlerts').setAttribute('aria-label',`فتح التحقق: ${count} ملاحظة`);
  }
  function chartCard(title,subtitle,body,cls=''){return `<article class="chartCard ${cls}"><div class="chartHeading"><div><h3>${title}</h3><p>${subtitle}</p></div><span class="chartIcon">${icon('chart')}</span></div>${body}</article>`;}
  function renderVisualDashboard(){
    if(!state)return;
    const data=identityChartData(eligibleExams(),e=>!!validRoomLabel(e.room)&&roomRecord(e.room)?.enabled!==false);
    const total=data.total,values=[data.status.complete,data.status.partial,data.status.empty],colors=['#18aa91','#e7b04b','#cf6470'];
    let offset=0;const segments=values.map((v,i)=>{const percent=total?v/total*100:0;const result=`<circle cx="110" cy="110" r="80" pathLength="100" fill="none" stroke="${colors[i]}" stroke-width="20" stroke-dasharray="${percent} ${100-percent}" stroke-dashoffset="${-offset}" transform="rotate(-90 110 110)"/>`;offset+=percent;return result;}).join('');
    const percentage=total?Math.round(values[0]/total*100):0;
    const legend=['قاعة ومراقبان','إسناد جزئي','بلا إسناد'].map((label,i)=>`<div class="chartLegend"><span><i style="background:${colors[i]}"></i>${label}</span><b>${digits(values[i])}</b></div>`).join('');
    const donut=`<div class="donutLayout"><svg viewBox="0 0 220 220" class="donutChart" role="img" aria-label="قاعة ومراقبان ${values[0]}، إسناد جزئي ${values[1]}، بلا إسناد ${values[2]}"><circle cx="110" cy="110" r="80" stroke="#e9f0ee" stroke-width="20" fill="none"/>${segments}<text x="110" y="108" text-anchor="middle" class="donutNumber">${digits(percentage)}٪</text><text x="110" y="133" text-anchor="middle" class="donutCaption">اكتمال الإسناد</text></svg><div class="legendList">${legend}<p class="chartFootnote">الاعتماد النهائي من تبويب التحقق</p></div></div>`;
    const maxDay=Math.max(1,...data.days.map(d=>d.value));
    const dayBars=data.days.length?`<div class="dayChart" role="img" aria-label="عدد الشعب حسب اليوم والتاريخ">${data.days.map(d=>`<div class="dayBarGroup"><b>${digits(d.value)}</b><div class="dayBarTrack"><div class="dayBar" style="height:${d.value/maxDay*100}%"></div></div><span>${safe(d.day)}</span><small dir="ltr">${safe(digits(d.date||'—'))}</small></div>`).join('')}</div>`:'<div class="chartEmpty">تظهر أعداد الشعب بعد استيراد جدول الاختبارات</div>';
    const maxDept=Math.max(1,...data.departments.map(d=>d.value));
    const deptBars=data.departments.length?`<div class="departmentChart">${data.departments.map(d=>`<div class="departmentBarGroup"><div><span>${safe(d.label)}</span><b>${digits(d.value)}</b></div><div class="horizontalTrack"><div style="width:${d.value/maxDept*100}%"></div></div></div>`).join('')}</div>`:'<div class="chartEmpty">تظهر الأقسام من بيانات الشعب المجدولة</div>';
    document.getElementById('identityDashboard').innerHTML=chartCard('حالة الإسناد',`${digits(total)} شعبة مجدولة`,donut,'statusChart')+chartCard('الشعب حسب الأيام','عدد الشعب في كل يوم وتاريخ',dayBars,'daysChart')+chartCard('الشعب حسب الأقسام','من بيانات جدول الاختبارات',deptBars,'departmentsChart');
  }
  function renderReportCharts(){
    const counts=countAssignments(),entries=Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ar')),departments=new Map();
    for(const [name,count] of entries){const dept=state.trainers.find(t=>t.name===name)?.dept||'غير محدد';departments.set(dept,(departments.get(dept)||0)+count);}
    const bars=(rows)=>{const max=Math.max(1,...rows.map(r=>r[1]));return rows.length?`<div class="departmentChart">${rows.map(([label,value])=>`<div class="departmentBarGroup"><div><span>${safe(label)}</span><b>${digits(value)}</b></div><div class="horizontalTrack"><div style="width:${value/max*100}%"></div></div></div>`).join('')}</div>`:'<div class="chartEmpty">تظهر الإحصاءات بعد إسناد المراقبات</div>';};
    document.getElementById('identityReportCharts').innerHTML=chartCard('تكليفات المراقبة حسب الأقسام','حسب قسم المدرب؛ كل خانة مراقبة تكليف واحد',bars([...departments]),'')+chartCard('أكثر المدربين تكليفًا','أعلى عشرة حسب عدد المراقبات الفعلي',bars(entries.slice(0,10)),'');
  }
  function indicatorRow(target,items){document.getElementById(target).innerHTML=items.map(([label,value,type])=>`<div class="compactIndicator"><span class="compactIcon">${icon(type)}</span><div><span>${label}</span><strong>${digits(value)}</strong></div></div>`).join('');}
  const originalMetrics=renderMetrics;renderMetrics=function(){originalMetrics();decorateMetrics(document.getElementById('metrics'));renderVisualDashboard();};
  const originalAudit=renderAudit;renderAudit=function(){originalAudit();decorateMetrics(document.getElementById('auditSummary'));updateAlerts();};
  const originalReports=renderReports;renderReports=function(){originalReports();const counts=[...document.querySelectorAll('#trainerCounts .countRow')];const max=Math.max(1,...counts.map(r=>Number(r.querySelector('strong').textContent)));counts.forEach(row=>row.style.setProperty('--count-fill',`${Number(row.querySelector('strong').textContent)/max*100}%`));renderReportCharts();};
  const originalTrainers=renderTrainers;renderTrainers=function(){originalTrainers();indicatorRow('identityTrainerStats',[
    ['إجمالي المدربين',state.trainers.length,'trainers'],['المدربون النشطون',state.trainers.filter(activeTrainer).length,'check'],['غير نشط',state.trainers.filter(t=>!activeTrainer(t)).length,'availability'],['الأقسام',new Set(state.trainers.map(t=>t.dept).filter(Boolean)).size,'rooms']
  ]);};
  const originalRooms=renderRooms;renderRooms=function(){originalRooms();indicatorRow('identityRoomStats',[
    ['إجمالي القاعات',state.rooms.length,'rooms'],['محددة للتوزيع',state.rooms.filter(r=>r.enabled!==false).length,'check'],['مستبعدة',state.rooms.filter(r=>r.enabled===false).length,'availability']
  ]);};
  document.querySelector('#report-trainers .grid').insertAdjacentHTML('beforebegin','<div id="identityReportCharts" class="reportCharts"></div>');
  for(const [page,id] of [['trainers','identityTrainerStats'],['rooms','identityRoomStats']])document.querySelector(`#page-${page} .sectionHead`).insertAdjacentHTML('afterend',`<div id="${id}" class="compactIndicators" aria-label="ملخص ${page==='trainers'?'المدربين':'القاعات'}"></div>`);
  document.querySelectorAll('#tabs button[data-page]').forEach(button=>button.insertAdjacentHTML('afterbegin',icon(button.dataset.page)));
  document.querySelectorAll('.page').forEach(page=>{const heading=page.querySelector('h2');if(heading)heading.insertAdjacentHTML('afterbegin',`<span class="pageHeadingIcon">${icon(page.id.replace('page-',''))}</span>`);});
  document.getElementById('identityAlerts').insertAdjacentHTML('afterbegin',icon('bell'));
  document.getElementById('identitySettings').innerHTML=icon('settings');
  document.getElementById('identityAlerts').onclick=()=>document.querySelector('#tabs [data-page="audit"]').click();
  document.getElementById('identitySettings').onclick=()=>document.querySelector('#tabs [data-page="periods"]').click();
  if(typeof state!=='undefined'&&state){renderMetrics();renderTrainers();renderRooms();renderReports();renderAudit();}
})();
if(typeof module!=='undefined'&&module.exports)module.exports={identityChartData};
