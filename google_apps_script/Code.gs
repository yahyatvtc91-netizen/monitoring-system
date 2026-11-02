/** بوابة عرض مراقبات المدربين؛ تُقرأ البيانات من ورقة «مراقبات» فقط. */
const SPREADSHEET_ID = 'ضع_معرف_جدول_قوقل_هنا';
const SHEET_NAME = 'مراقبات';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('جدول مراقبات المدرب');
}

function getSchedule(employeeId) {
  const id = String(employeeId || '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\s/g, '');
  if (!/^\d{3,15}$/.test(id)) throw new Error('أدخل رقمًا وظيفيًا صحيحًا.');
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('ورقة «مراقبات» غير موجودة.');
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return {name:'',rows:[]};
  const expected = ['الرقم الوظيفي','اسم المدرب','القسم','اليوم','التاريخ','الفترة','الوقت','المقرر','الشعبة','القاعة'];
  if (expected.some((x,i) => values[0][i] !== x)) throw new Error('عناوين الورقة لا تطابق ملف التصدير.');
  const matched = values.slice(1).filter(row => String(row[0]).trim() === id);
  return {name:matched[0]?.[1] || '',rows:matched.map(row => row.slice(2,10))};
}
