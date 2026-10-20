// 醸造百選の陣取り：通信対戦の層。中身（Backend）を差し替えられる。
// - LocalBackend：IndexedDB（読んで比べて書くを一つの取引で）＋BroadcastChannel（中身つきの知らせ）。同じブラウザの別タブ同士で本物と同じようにつながる（試遊・テスト用）
// - FirebaseBackend：Firebase Realtime Database＋匿名認証（SDK は gstatic の版を固定して読む）
// js/firebase_config.js の設定が null の間は LocalBackend。
// 部屋（rooms/<合言葉>）の中身：
// seed（乱数の種）・n（人数）・state（"wait"＝待つ／"play"＝遊ぶ）・host（待つ間の親の利用者ID）・created（作った時刻＝後で古い部屋を消す目印）
// seats：席0〜3 → { kind: "人"|"コンピュータ"|"空き", level: "やさしい"|"ふつう"|"つよい"|null, uid: 人の利用者ID|null }
// ※ n・seats・host は「始める」で固まる（以後は書き換えない）。遊ぶ間の席の入れ替え（CPUに替える）と親の引き継ぎは、手の列に積む
// moves：手の列（足すだけ）。0,1,2,… → { k: "roll"|"stay"|"move"|"pick"|"dest"|"seat"|"host", path?, ids?, p?, i?, level?, by: 積んだ利用者ID, fp: 指紋 }
// online：いまつながっている利用者ID（受け取る側では uid の配列に直す）
// 共通の口（どの Backend も同じ）：
// init() → uid ／ createRoom(room) → 合言葉 ／ getRoom(code) ／ watch(code, cb) → 止める関数（cb(room) は変わるたびに）
// takeSeat(code, i) → bool ／ setSeat(code, i, seat)（親）／ update(code, patch)（親）
// pushMove(code, n, move) → bool（n 番目が空いていたときだけ、必ず一方だけ通る）／ claimHost(code) → bool（待つ間に親がいないときだけ）／ leave(code)
import { firebaseConfig } from "./firebase_config.js";

export const FIREBASE_VERSION = "10.14.1"; // 2024-10 の版（固定）
const SEATS = 4;
const EMPTY = () => ({ kind: "空き", level: null, uid: null });

// ---- 共通の決まりごと ----
export const newCode = () => String(Math.floor(Math.random() * 10000)).padStart(4, "0"); // 合言葉：数字四桁
// 作られてから一日を過ぎた部屋は、同じ合言葉で作り直してよい（部屋は消せないので、合言葉が尽きないように）。
// 時計のずれで規則に拒まれないよう、手元では十分を足して見る（規則は created < now − 86400000）
export const ROOM_LIFE = 86400000;
export const stale = (room, now = Date.now()) => !room || (typeof room.created === "number" && room.created < now - ROOM_LIFE - 600000);
export function newRoomData(uid) {
  const seats = []; for (let i = 0; i < SEATS; i++) seats.push(EMPTY());
  seats[0] = { kind: "人", level: null, uid };
  return { seed: (Math.random() * 2 ** 32) >>> 0, n: 2, state: "wait", host: uid, created: Date.now(), seats };
}
// Firebase は数の鍵を配列で返したり、空の配列や null を落としたりするので、形をそろえる
export function seatsOf(room) {
  const s = room && room.seats || [], out = [];
  for (let i = 0; i < SEATS; i++) out.push(Object.assign(EMPTY(), s[i] || {}));
  return out;
}
export function movesOf(room) { // 0 から途切れずに続く手だけ
  const m = room && room.moves || {}, out = [];
  for (let i = 0; m[i] != null; i++) out.push(m[i]);
  return out;
}
const seated = (room, uid) => seatsOf(room).some(s => s.kind === "人" && s.uid === uid);
// 手をエンジンに渡すのは index.html の applyAct（この端末で遊ぶときも同じ口を通す）
// 指紋：手を再生したあとの盤のようす（手数・手番・段・目的地・目・駒・色・色札・持ち主）を短い文字に。端末ごとに見比べてずれを見つける
export function fingerprint(g) {
  const s = JSON.stringify([g.t, g.phase, g.cur, g.dest, g.left, g.dice, g.players.map(p => [p.pos, p.moves, p.held, p.dice2 ? 1 : 0]),
    g.owner, g.chips, g.holder]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---- LocalBackend：同じブラウザの別タブ同士 ----
// 部屋の正は IndexedDB（タブをまたいでも取引が一つずつ通る＝同じ番号に同時に積んでも一方だけ）。
// 書いたら中身（rev つき）を BroadcastChannel で配る。受け取った側は、中身と IndexedDB の新しい方を使う（知らせが先に着いても取りこぼさない）。
const LS = "jintori.";
export class LocalBackend {
  constructor() {
    this.kind = "local";
    this.subs = {}; this.beats = {}; this.lastOnline = {}; this.best = {}; // best＝合言葉 → いちばん新しい部屋（rev）
    this.ch = new BroadcastChannel("jintori-net");
    this.ch.onmessage = e => this._fire(e.data.code, e.data.room);
    addEventListener("pagehide", () => { for (const c of Object.keys(this.beats)) this._offline(c); });
  }
  async init() { // タブごとの利用者ID（sessionStorage＝再読み込みしても同じ。匿名認証の代わり）
    let u = sessionStorage.getItem(LS + "uid");
    if (!u) { u = "L" + Math.random().toString(36).slice(2, 10); sessionStorage.setItem(LS + "uid", u); }
    this.db = await new Promise((ok, ng) => { const q = indexedDB.open("jintori-net", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("rooms"); q.onsuccess = () => ok(q.result); q.onerror = () => ng(q.error); });
    return (this.uid = u);
  }
  _get(code) { return new Promise((ok, ng) => { const q = this.db.transaction("rooms").objectStore("rooms").get(code); q.onsuccess = () => ok(q.result || null); q.onerror = () => ng(q.error); }); }
  _online(code) { // 拍が5秒以内の利用者だけ
    let o = {}; try { o = JSON.parse(localStorage.getItem(LS + "online." + code)) || {}; } catch (e) {}
    const now = Date.now(); return Object.keys(o).filter(u => now - o[u] < 5000).sort();
  }
  _keep(code, r) { const b = this.best[code]; if (r && (!b || (r.rev || 0) > (b.rev || 0))) this.best[code] = r; return this.best[code] || null; }
  async _fire(code, carried) {
    if (!this.subs[code] || !this.subs[code].length) return;
    this._keep(code, carried);
    const r = this._keep(code, await this._get(code)); // 知らせの中身と IndexedDB の新しい方
    if (!r) return;
    const out = JSON.parse(JSON.stringify(r)); out.online = this._online(code);
    for (const cb of (this.subs[code] || []).slice()) cb(out);
  }
  // 読んで比べて書く：IndexedDB の readwrite 取引の中で。fn(room) が undefined を返したら書かない
  _tx(code, fn) {
    return new Promise((ok, ng) => {
      const t = this.db.transaction("rooms", "readwrite"), st = t.objectStore("rooms"), q = st.get(code);
      let out;
      q.onsuccess = () => { out = fn(q.result ? JSON.parse(JSON.stringify(q.result)) : null); if (out !== undefined) { out.rev = ((q.result && q.result.rev) || 0) + 1; st.put(out, code); } };
      t.oncomplete = () => {
        if (out === undefined) return ok(false);
        try { localStorage.setItem(LS + "room." + code, JSON.stringify(out)); } catch (e) {}
        this.ch.postMessage({ code, room: out }); setTimeout(() => this._fire(code, out), 0);
        ok(true);
      };
      t.onerror = () => ng(t.error);
    });
  }
  async createRoom(data) {
    for (let k = 0; k < 50; k++) { const code = newCode(); if (await this._tx(code, r => stale(r) ? data : undefined)) return code; } // 重なったら作り直す（一日を過ぎた部屋はまるごと置き換える）
    throw new Error("code");
  }
  async getRoom(code) { const r = this._keep(code, await this._get(code)); if (!r) return null; const o = JSON.parse(JSON.stringify(r)); o.online = this._online(code); return o; }
  watch(code, cb) {
    (this.subs[code] = this.subs[code] || []).push(cb);
    if (!this.beats[code]) { // つながっている印：1.5秒ごとの拍。つながっている人が変わったときだけ知らせる
      const beat = () => {
        let o = {}; try { o = JSON.parse(localStorage.getItem(LS + "online." + code)) || {}; } catch (e) {}
        o[this.uid] = Date.now(); localStorage.setItem(LS + "online." + code, JSON.stringify(o));
        const now = this._online(code).join();
        if (now !== this.lastOnline[code]) { this.lastOnline[code] = now; this.ch.postMessage({ code }); this._fire(code); }
      };
      beat(); this.beats[code] = setInterval(beat, 1500);
    }
    setTimeout(() => this._fire(code), 0);
    return () => { this.subs[code] = (this.subs[code] || []).filter(f => f !== cb); };
  }
  _offline(code) {
    clearInterval(this.beats[code]); delete this.beats[code];
    let o = {}; try { o = JSON.parse(localStorage.getItem(LS + "online." + code)) || {}; } catch (e) {}
    delete o[this.uid]; localStorage.setItem(LS + "online." + code, JSON.stringify(o)); this.ch.postMessage({ code });
  }
  async leave(code) {
    await this._tx(code, r => { if (!r || r.state !== "wait") return; const s = seatsOf(r); let ch = false;
      s.forEach((x, i) => { if (x.uid === this.uid) { s[i] = EMPTY(); ch = true; } }); return ch ? Object.assign(r, { seats: s }) : undefined; });
    this._offline(code); delete this.subs[code];
  }
  takeSeat(code, i) { // 空いている席か自分の席だけ。ほかに座っていた自分の席は空ける
    return this._tx(code, r => {
      if (!r || r.state !== "wait") return; const s = seatsOf(r);
      if (!(s[i].kind === "空き" || s[i].uid === this.uid)) return;
      s.forEach((x, j) => { if (j !== i && x.uid === this.uid) s[j] = EMPTY(); });
      s[i] = { kind: "人", level: null, uid: this.uid };
      return Object.assign(r, { seats: s });
    });
  }
  setSeat(code, i, seat) { // 親：空き・CPU の席だけ（人の席は奪えない）
    return this._tx(code, r => { if (!r || r.state !== "wait" || r.host !== this.uid) return; const s = seatsOf(r);
      if (s[i].kind === "人" && s[i].uid !== this.uid) return; if (seat.kind === "人") return;
      s[i] = Object.assign(EMPTY(), seat); return Object.assign(r, { seats: s }); });
  }
  update(code, patch) { // 親：待つ間の人数と、待つ→遊ぶ
    return this._tx(code, r => { if (!r || r.state !== "wait" || r.host !== this.uid) return;
      if ("n" in patch && ![2, 3, 4].includes(patch.n)) return; if ("state" in patch && patch.state !== "play") return;
      return Object.assign(r, { n: patch.n ?? r.n, state: patch.state ?? r.state }); });
  }
  pushMove(code, n, m) { // 遊ぶ間・席に座っている人だけ・n 番目が空いていて途切れていないときだけ（足すだけ）
    return this._tx(code, r => {
      if (!r || r.state !== "play" || m.by !== this.uid || !seated(r, this.uid)) return; const ms = r.moves || {};
      if (ms[n] != null || movesOf(r).length !== n) return;
      ms[n] = m; return Object.assign(r, { moves: ms });
    });
  }
  claimHost(code) { // 待つ間に、親がつながっていなければ、座っている自分が親を引き継ぐ
    const on = this._online(code);
    return this._tx(code, r => (!r || r.state !== "wait" || on.includes(r.host) || !on.includes(this.uid) || !seated(r, this.uid)) ? undefined : Object.assign(r, { host: this.uid }));
  }
}

// ---- FirebaseBackend：Realtime Database＋匿名認証 ----
export class FirebaseBackend {
  constructor(config) { this.kind = "firebase"; this.config = config; }
  async init() {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
    const [A, Au, D] = await Promise.all([import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-database.js")]);
    this.D = D;
    const app = A.initializeApp(this.config);
    const auth = Au.getAuth(app);
    const cred = await Au.signInAnonymously(auth); // 匿名の利用者ID（同じブラウザなら全タブ同じ・入り直しても同じ＝席を覚える）
    this.db = D.getDatabase(app);
    return (this.uid = cred.user.uid);
  }
  r(path) { return this.D.ref(this.db, path); }
  async _txn(path, fn) { try { return (await this.D.runTransaction(this.r(path), fn, { applyLocally: false })).committed; } // 通るまで手元の値に出さない（負けた手が一瞬見えない）
     catch (e) { console.warn(e); return false; } }
  // 作る：rooms/<合言葉> と makers/<自分>（作った時刻）を一度に書く。規則が「まだ無い（か一日を過ぎた）合言葉」と「前に作ってから30秒」を見る
  async createRoom(data) {
    for (let k = 0; k < 20; k++) {
      const code = newCode();
      if (!stale((await this.D.get(this.r("rooms/" + code))).val())) continue; // 重なったら作り直す（一日を過ぎた部屋は、まるごと置き換えてよい）
      const t = this.D.serverTimestamp();
      // update の鍵 "rooms/<合言葉>" は、その下をまるごと置き換える（古い moves・online は残らない）
      try { await this.D.update(this.r("/"), { ["rooms/" + code]: Object.assign({}, data, { created: t }), ["makers/" + this.uid]: t }); return code; }
      catch (e) { console.warn(e); if (/permission/i.test(String(e)) && k > 2) throw e; }
    }
    throw new Error("code");
  }
  async getRoom(code) { const s = await this.D.get(this.r("rooms/" + code)); return this._norm(s.val()); }
  _norm(v) { if (v) v.online = Object.keys(v.online || {}).sort(); return v; }
  watch(code, cb) {
    const me = this.r(`rooms/${code}/online/${this.uid}`);
    // つながるたびに印を付け、切れたら消える（onDisconnect）
    const offC = this.D.onValue(this.r(".info/connected"), s => { if (s.val() === true) {
      this.D.onDisconnect(me).remove().then(() => this.D.set(me, true)).catch(e => console.warn(e)); } });
    const offR = this.D.onValue(this.r("rooms/" + code), s => cb(this._norm(s.val())));
    this.offs = this.offs || {}; this.offs[code] = [offC, offR];
    return () => { offC(); offR(); };
  }
  async leave(code) {
    try {
      const r = await this.getRoom(code);
      if (r && r.state === "wait") { const s = seatsOf(r); for (let i = 0; i < s.length; i++) if (s[i].uid === this.uid) await this.D.set(this.r(`rooms/${code}/seats/${i}`), { kind: "空き" }); }
      for (const f of (this.offs && this.offs[code]) || []) f();
      await this.D.remove(this.r(`rooms/${code}/online/${this.uid}`));
    } catch (e) { console.warn(e); }
  }
  async takeSeat(code, i) {
    const ok = await this._txn(`rooms/${code}/seats/${i}`, s => (!s || s.kind === "空き" || s.uid === this.uid) ? { kind: "人", uid: this.uid } : undefined);
    if (!ok) return false;
    try { const r = await this.getRoom(code);
      if (r && r.state === "wait") { const s = seatsOf(r); for (let j = 0; j < s.length; j++) if (j !== i && s[j].uid === this.uid) await this.D.set(this.r(`rooms/${code}/seats/${j}`), { kind: "空き" }); }
    } catch (e) { console.warn(e); }
    return true;
  }
  setSeat(code, i, seat) { // null を落とした形で書く（規則は uid が無いことを見る）
    const v = { kind: seat.kind }; if (seat.level) v.level = seat.level; if (seat.uid) v.uid = seat.uid;
    return this.D.set(this.r(`rooms/${code}/seats/${i}`), v).then(() => true, e => { console.warn(e); return false; });
  }
  update(code, patch) { return this.D.update(this.r("rooms/" + code), patch).then(() => true, e => { console.warn(e); return false; }); }
  // 同じ番号へは runTransaction（無ければ書く）。規則も「まだ無い番号だけ」なので、必ず一方だけ通る
  pushMove(code, n, m) { return this._txn(`rooms/${code}/moves/${n}`, cur => cur === null ? m : undefined); }
  async claimHost(code) {
    const r = await this.getRoom(code).catch(() => null);
    if (!r || r.state !== "wait" || r.online.includes(r.host) || !r.online.includes(this.uid) || !seated(r, this.uid)) return false;
    return this._txn(`rooms/${code}/host`, h => h === r.host ? this.uid : undefined);
  }
}

// 設定があれば Firebase、無ければ同じブラウザの中だけでつなぐ
export function makeBackend() { return firebaseConfig ? new FirebaseBackend(firebaseConfig) : new LocalBackend(); }
