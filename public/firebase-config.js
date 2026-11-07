// ค่าเชื่อมต่อ Firebase — คัดลอกมาจาก Firebase Console:
// Project settings → General → Your apps → Web app → SDK setup and configuration → Config
// (ค่านี้ไม่ใช่ความลับ ใส่ในหน้าเว็บได้ ความปลอดภัยดูแลด้วย firestore.rules)
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: '000000000000',
  appId: 'YOUR_APP_ID',
};
