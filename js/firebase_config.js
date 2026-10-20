// 通信対戦の Firebase 設定。null の間は js/net.js が LocalBackend（同じブラウザの別タブ同士）を使う。
// プロジェクト jozo-jintori（Realtime Database・asia-southeast1・匿名認証）を作ったら、コンソールの「ウェブアプリ」の設定をここに貼る。例：
// export const firebaseConfig = {
// apiKey: "…", authDomain: "jozo-jintori.firebaseapp.com",
// databaseURL: "https://jozo-jintori-default-rtdb.asia-southeast1.firebasedatabase.app",
// projectId: "jozo-jintori", appId: "…",
// };
export const firebaseConfig = {
  apiKey: "AIzaSyDyzGPHZz161y4PbeYeWaE9s7vH48B75Cs",
  authDomain: "jozo-jintori.firebaseapp.com",
  databaseURL: "https://jozo-jintori-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "jozo-jintori",
  storageBucket: "jozo-jintori.firebasestorage.app",
  messagingSenderId: "846144519116",
  appId: "1:846144519116:web:2a1bd74e7e8b482d553b69",
};
