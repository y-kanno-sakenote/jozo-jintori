(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory;
  else root.JintoriEngine = factory;
})(this, function (DATA, EVENTS) {
  "use strict";
  // ---- 数値（叩き台。newGame の opt.params で上書きできる）----
  const PARAMS = {
    turns: { 2: 20, 3: 13, 4: 10 }, // 一人の手数
    chips: { pass: 1, stop: 2, dest: 3 }, // 撒くチップ：通った県・止まった県（とどまる含む）・目的地。県ごと・人ごとに局の終わりまで貯まる
    cost: { 1: 1, 2: 1, 4: 2, 8: 3 },     // 品のコスト（熟成の段 stage → チップの枚数）。その県に貯めた自分のチップで払う。3か月以内1・1年以内2・1年超3
    bless: 2,     // 恵み：止まった県にもう撒くチップ
    // 目的地に着いたら allocDest 枚おまけ（配る数に足す）。とどまるときは、いる県に allocStay 枚
    alloc: false, allocDest: 2, allocStay: 2,
    dice: 6,      // サイコロの面
    // 先手有利の補正：1手目は、品が1つしかない県の品を取れない
    firstNoOne: false,
    order: "seat", // 双六のように席の順のまま
    // 時代と地域の出来事：止まった県（とどまる含む）で、この割合で起きる。種類を重みで先に選んでから、その県の出来事を1件
    evRate: 1 / 4,
    evWeight: { "災い": 1, "恵み": 2, "道がひらく": 2, "行事": 1 },
    // 同数のとき：keep＝いまの色の人のまま（追いつくだけでは奪えない）／last＝その県で最後に品を取った人
    tie: "keep",
  }; // 手番は席の順のまま
  const EV_AT = {}; // 県 → 出来事（種類が「どれでもない」は data/events.js に入れていない）
  for (const p of Object.keys(DATA.tiles)) EV_AT[p] = [];
  for (const e of EVENTS || []) EV_AT[e.pref].push(e);
  const PREFS = Object.keys(DATA.tiles);
  const NB = DATA.neighbors;
  const ENT = DATA.entries.map((e, id) => Object.assign({ id }, e)); // 都道府県別の169品
  const AT = {};
  for (const p of PREFS) AT[p] = [];
  for (const e of ENT) AT[e.pref].push(e.id);

  // 最短の距離
  const DIST = {};
  for (const a of PREFS) {
    const d = { [a]: 0 }, q = [a];
    while (q.length) { const u = q.shift(); for (const v of NB[u]) if (!(v in d)) { d[v] = d[u] + 1; q.push(v); } }
    DIST[a] = d;
  }
  // ちょうど n 歩で行ける県：同じ県を二度通らない道で n 歩目に着く県
  const REACH = {};
  function reach(from, n) {
    const key = from + n;
    if (REACH[key]) return REACH[key];
    const out = [], seen = new Set([from]);
    for (const t of PREFS) {
      if (t === from || DIST[from][t] > n) continue;
      const found = (function walk(u, k) {
        if (k === n) return u === t;
        if (u === t || n - k < DIST[u][t]) return false;
        for (const v of NB[u]) if (!seen.has(v)) { seen.add(v); const ok = walk(v, k + 1); seen.delete(v); if (ok) return true; }
        return false;
      })(from, 0);
      if (found) out.push(t);
    }
    return (REACH[key] = out.sort());
  }
  // ちょうど n 歩の道をすべて（コンピュータが道を選ぶため。人も同じ道の中から引く）
  const PATHS = {};
  function paths(from, n) {
    const key = from + n;
    if (PATHS[key]) return PATHS[key];
    const out = [], seen = new Set([from]), cur = [];
    (function walk(u) {
      if (cur.length === n) { out.push(cur.slice()); return; }
      for (const v of NB[u]) if (!seen.has(v)) { seen.add(v); cur.push(v); walk(v); cur.pop(); seen.delete(v); }
    })(from);
    return (PATHS[key] = out);
  }

  function rng(seed) { // mulberry32（種は先に混ぜる：続き番号の種で最初の目が偏らないように）
    let a = seed >>> 0;
    a = Math.imul(a ^ (a >>> 16), 0x45d9f3b); a = Math.imul(a ^ (a >>> 16), 0x45d9f3b); a = (a ^ (a >>> 16)) >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pickOne = (g, arr) => arr[Math.floor(g.rand() * arr.length)];

  // opt: { seed, seats: [{ name, kind: "人"|"コンピュータ", level }], params }
  function newGame(opt) {
    const P = Object.assign({}, PARAMS, opt.params || {});
    const g = {
      P, rand: rng(opt.seed || 1), t: 0, seq: 0, cur: 0, dest: null, phase: "choose", dice: null, options: null,
      holder: {},  // 品の id → 持っている席の番号（早い者勝ち。持ち主は変わらない）
      cnt: {},     // 県 → 席ごとの、その県で取った品のコストの合計
      last: {},    // 県 → 席ごとの、その県で最後に品を取った順番（同数のときに比べる）
      owner: {},   // 県 → 色の席の番号（まだ誰の色でもなければ無い）
      chips: {},   // 県 → 席ごとの、その県に貯めたチップの数
      left: ENT.length, // 誰も持っていない品の数
      pick: null,  // 選ぶ板：[{ pref, chips, ids, cost }]（道の順。いま払える品がある県だけ。ids＝払える品・cost＝品の id → 枚数）
      rec: null,   // いまの手の記録
      log: [], over: false, winner: null,
      stats: { paints: [], leftByTurn: [], destHits: 0, gets: [], ev: {}, lost: 0 },
    };
    for (const p of PREFS) { g.cnt[p] = []; g.last[p] = []; g.chips[p] = []; }
    const used = new Set();
    g.players = opt.seats.map((s, i) => {
      let p; do p = pickOne(g, PREFS); while (used.has(p)); used.add(p);
      for (const q of PREFS) { g.cnt[q][i] = 0; g.last[q][i] = -1; g.chips[q][i] = 0; }
      return Object.assign({ i, pos: p, moves: 0, dests: 0, held: 0, dice2: false, evs: 0 }, s);
    });
    g.perTurns = typeof P.turns === "number" ? P.turns : P.turns[g.players.length];
    g.turns = g.perTurns * g.players.length;
    newDest(g);
    return g;
  }
  const cur = g => g.players[g.cur];
  const free = (g, p) => AT[p].filter(id => !(id in g.holder)); // その県の、誰も持っていない品
  // 手番の人がいま取れる品（1手目は品が1つしかない県の品を取れない＝先手有利の補正）
  const takable = (g, p) => cur(g).moves === 0 && g.P.firstNoOne && AT[p].length === 1 ? [] : free(g, p);
  const costOf = (g, id) => g.P.cost[ENT[id].stage]; // 品のコスト（チップの枚数）
  // 手番の人がいま払える品（取れる品のうち、その県に貯めた自分のチップ以内のコスト）
  const affordable = (g, p) => takable(g, p).filter(id => costOf(g, id) <= g.chips[p][cur(g).i]);
  const countOf = (g, i) => PREFS.filter(p => g.owner[p] === i).length;
  // 県の色：その県で取った品のコストの合計（重み）がいちばん大きい人。同数なら tie=keep はいまの色の人のまま（その人が並んでいなければ最後に取った人）、tie=last は最後に取った人
  function ownerOf(g, p) {
    let best, bc = 0;
    for (const pl of g.players) {
      const c = g.cnt[p][pl.i];
      if (c > bc || (c === bc && c > 0 && g.last[p][pl.i] > g.last[p][best])) { best = pl.i; bc = c; }
    }
    const o = g.owner[p];
    if (g.P.tie === "keep" && o !== undefined && bc > 0 && g.cnt[p][o] === bc) return o;
    return best;
  }
  // 目的地：残りの品が4つ以上ある県（無ければ3つ以上。それも無ければ目的地なし）で、誰もいない、いまの目的地と別の県
  function destChoices(g) {
    const here = new Set(g.players.map(p => p.pos));
    for (const min of [4, 3]) {
      const c = PREFS.filter(p => !here.has(p) && p !== g.dest && free(g, p).length >= min);
      if (c.length) return c;
    }
    return [];
  }
  function newDest(g) { const c = destChoices(g); g.dest = c.length ? pickOne(g, c) : null; }

  // 振る：サイコロ1つ（道がひらいた次の手は2つ＝合計の目）
  function roll(g) {
    if (g.phase !== "choose") throw new Error("phase");
    const pl = cur(g), n = pl.dice2 ? 2 : 1; pl.dice2 = false;
    g.dice = []; for (let k = 0; k < n; k++) g.dice.push(1 + Math.floor(g.rand() * g.P.dice));
    g.options = reach(cur(g).pos, steps(g));
    g.phase = "move";
    return g.options;
  }
  const steps = g => g.dice.reduce((a, b) => a + b, 0);
  // 道の検査：いる県の隣から一県ずつ隣へ、長さ＝目の数、いる県も含めて同じ県を二度通らない
  function pathOk(g, path) {
    if (!Array.isArray(path) || path.length !== steps(g)) return false;
    const pos = cur(g).pos, seen = new Set([pos]);
    let u = pos;
    for (const v of path) { if (!NB[u] || !NB[u].includes(v) || seen.has(v)) return false; seen.add(v); u = v; }
    return true;
  }
  // 出来事：止まった県で evRate の割合。種類を重みで先に選び（その県にある種類だけ）、その種類から1件
  function drawEvent(g, p) {
    const list = EV_AT[p];
    if (!list.length || g.rand() >= g.P.evRate) return null;
    const kinds = Object.keys(g.P.evWeight).filter(k => g.P.evWeight[k] > 0 && list.some(e => e.kind === k));
    if (!kinds.length) return null;
    let r = g.rand() * kinds.reduce((a, k) => a + g.P.evWeight[k], 0), kind = kinds[kinds.length - 1];
    for (const k of kinds) { if ((r -= g.P.evWeight[k]) < 0) { kind = k; break; } }
    return pickOne(g, list.filter(e => e.kind === kind));
  }
  // チップを撒いて、選ぶ板を作る。list＝[[県, 撒く枚数]]（道の順）。品の残っていない県には撒かない。
  // 止まった県で出来事を引く：災い＝その県に前から貯めた自分のチップを失う（この手で撒いた分は残る）・恵み＝止まった県にもう bless 枚。
  // 品が取り尽くされた県（色が決まった県）では災い・恵みとも効き目なし（撒く先が無い）
  function board(g, list) {
    const pl = cur(g), out = g.rec.items, end = list[list.length - 1][0], ev = drawEvent(g, end);
    if (ev) {
      g.rec.event = ev; pl.evs++; g.stats.ev[ev.kind] = (g.stats.ev[ev.kind] || 0) + 1;
      if (ev.kind === "道がひらく") pl.dice2 = true; // 次の手はサイコロ2つ
      if (ev.kind === "災い" && free(g, end).length && g.chips[end][pl.i] > 0) {
        const n = g.chips[end][pl.i]; g.chips[end][pl.i] = 0; g.stats.lost += n;
        out.push({ type: "lost", pref: end, n }); // チップを失った（撒く前の分）
      }
      if (ev.kind === "恵み") list[list.length - 1] = [end, list[list.length - 1][1] + g.P.bless];
    }
    for (const [pref, n] of list) if (n > 0 && free(g, pref).length) {
      g.chips[pref][pl.i] += n;
      out.push({ type: "chips", pref, n, total: g.chips[pref][pl.i] }); // 撒いたチップ（total＝撒いたあとのその県の自分のチップ）
    }
    g.pick = list.map(([pref]) => ({ pref, chips: g.chips[pref][pl.i], ids: affordable(g, pref) })).filter(x => x.ids.length);
    for (const x of g.pick) { x.cost = {}; for (const id of x.ids) x.cost[id] = costOf(g, id); }
    g.rec.board = g.pick.length > 0; // 選ぶ板が出たか（出たのに選ばなかった、と、払える品が無かった、を分ける）
    g.phase = "pick";
    if (!g.pick.length) return afterPick(g);
    return g.rec;
  }
  // 道に沿って進む：path＝通る県の列（いる県は含めない。最後が着く県）。着いたらチップを撒いて選ぶ板（phase "pick"。払える品が無ければ飛ばす）
  function moveAlong(g, path) {
    if (g.phase !== "move") throw new Error("phase");
    const pl = cur(g);
    if (!g.options.length) { if (path && path.length) throw new Error("path"); path = []; }
    else if (!pathOk(g, path)) throw new Error("path");
    const end = path.length ? path[path.length - 1] : pl.pos;
    const dest = path.length > 0 && end === g.dest;
    pl.pos = end;
    g.rec = { who: pl.i, t: g.t, type: "move", path: path.slice(), dice: g.dice.slice(), dest, items: [] };
    if (dest) { pl.dests++; g.stats.destHits++; }
    const C = g.P.chips;
    if (g.P.alloc && path.length) {
      g.allocTo = path.filter(p => free(g, p).length); // 品の残っていない県には置けない
      g.allocN = steps(g) + (dest ? g.P.allocDest : 0);
      if (!g.allocTo.length) return board(g, [[end, 0]]); // 置ける県が無い：チップは消える
      g.phase = "alloc";
      return g.rec;
    }
    return board(g, [...path.slice(0, -1).map(p => [p, C.pass]), [end, dest ? C.dest : C.stop]]);
  }
  function allocate(g, counts) {
    if (g.phase !== "alloc") throw new Error("phase");
    const ks = Object.keys(counts || {});
    if (ks.some(p => !g.allocTo.includes(p) || !Number.isInteger(counts[p]) || counts[p] < 0)) throw new Error("alloc");
    if (ks.reduce((a, p) => a + counts[p], 0) !== g.allocN) throw new Error("alloc");
    const path = g.rec.path, end = path[path.length - 1];
    g.rec.alloc = Object.assign({}, counts);
    g.allocTo = null; g.allocN = null;
    return board(g, [...path.slice(0, -1).map(p => [p, counts[p] || 0]), [end, counts[end] || 0]]);
  }
  // とどまる：いる県にチップを stop 枚
  function stay(g) {
    if (g.phase !== "choose") throw new Error("phase");
    const pl = cur(g); pl.dice2 = false; // 道がひらいた手でとどまったら、サイコロ2つは使わずに消える
    g.rec = { who: pl.i, t: g.t, type: "stay", path: [], items: [] };
    return board(g, [[pl.pos, g.P.alloc ? g.P.allocStay : g.P.chips.stop]]);
  }
  // 選ぶ：chosen＝品の id の列。板の県ごとに、コストの合計がその県の自分のチップ以内（超えたら拒む）。払ったチップは消える。
  // 取らずに貯めておくのも自由（空の列でよい）
  function pick(g, chosen) {
    if (g.phase !== "pick") throw new Error("phase");
    const ids = [...new Set(chosen || [])];
    if (ids.some(id => !g.pick.some(x => x.ids.includes(id)))) throw new Error("pick");
    for (const x of g.pick) if (ids.filter(id => x.ids.includes(id)).reduce((a, id) => a + x.cost[id], 0) > x.chips) throw new Error("pick");
    const pl = cur(g), out = g.rec.items;
    for (const x of g.pick) { // 道の順に取り、県ごとに色を見直す
      const mine = ids.filter(id => x.ids.includes(id));
      if (!mine.length) continue;
      const p = x.pref, before = g.owner[p];
      for (const id of mine) {
        g.chips[p][pl.i] -= x.cost[id];
        g.holder[id] = pl.i; g.cnt[p][pl.i] += x.cost[id]; g.last[p][pl.i] = g.seq++; g.left--; pl.held++;
        out.push({ type: "get", pref: p, id, name: ENT[id].name, cost: x.cost[id] });
      }
      const after = ownerOf(g, p);
      if (after !== before) { g.owner[p] = after; out.push({ type: "paint", pref: p, from: before, to: after });
        g.stats.paints.push({ t: g.t, pref: p, from: before, to: after }); }
    }
    return afterPick(g);
  }
  // 選んだあと：目的地に着いていたら次の目的地。行事＝次の目的地を自分で決める（phase "dest"。残りの品が4つ以上の県から＝ふつうの目的地と同じ候補）
  function afterPick(g) {
    const rec = g.rec, ev = rec.event;
    g.pick = null;
    if (rec.dest) newDest(g);
    if (ev && ev.kind === "行事") {
      g.choices = destChoices(g);
      if (g.choices.length) { g.phase = "dest"; return rec; }
    }
    return endTurn(g);
  }
  // 行事：次の目的地を決める（いまの目的地と入れ替わる）
  function setDest(g, p) {
    if (g.phase !== "dest" || !g.choices.includes(p)) throw new Error("dest");
    g.dest = p; g.rec.chose = p; g.choices = null;
    return endTurn(g);
  }
  function endTurn(g) {
    const pl = cur(g), rec = g.rec;
    pl.moves++;
    g.log.push(rec);
    g.stats.gets.push(rec.items.filter(o => o.type === "get").length);
    if (g.dest && !free(g, g.dest).length) newDest(g); // 目的地の品が取り尽くされたら次へ
    g.t++;
    g.stats.leftByTurn.push(g.left);
    g.dice = null; g.options = null; g.pick = null; g.rec = null;
    if (g.t >= g.turns || g.left === 0) { finish(g); return rec; }
    const N = g.players.length; // 席の順。rotate は巡ごとに最初に振る人を一人ずつずらす
    g.cur = g.P.order === "rotate" ? (g.t + Math.floor(g.t / N)) % N : g.t % N;
    g.phase = "choose";
    return rec;
  }
  // 終わり：塗った県の多い人の勝ち。並べば得た品の数（169品のうち）の多い人。それでも並べば引き分け（winner＝null）
  function finish(g) {
    g.over = true; g.phase = "over";
    const sc = g.players.map(pl => ({ i: pl.i, prefs: countOf(g, pl.i), held: pl.held }));
    sc.sort((a, b) => b.prefs - a.prefs || b.held - a.held);
    g.score = sc;
    g.winner = sc.length > 1 && sc[0].prefs === sc[1].prefs && sc[0].held === sc[1].held ? null : sc[0].i;
  }

  // 漢数字（「四十二」「千二百」）
  const D1 = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  function kanji(n) {
    n = Math.floor(n);
    if (n === 0) return "零";
    if (n < 0) return "負" + kanji(-n);
    let s = "";
    const man = Math.floor(n / 10000), r = n % 10000;
    if (man) s += kanji(man) + "万";
    for (const [u, c] of [[1000, "千"], [100, "百"], [10, "十"]]) { const d = Math.floor(r / u) % 10; if (d) s += (d === 1 ? "" : D1[d]) + c; }
    return s + D1[r % 10];
  }

  return {
    PARAMS, newGame, roll, steps, pathOk, moveAlong, allocate, stay, pick, setDest, destChoices, cur, free, takable, affordable, costOf, ownerOf, countOf,
    PREFS, AT, ENT, NB, DIST, reach, paths, rng, kanji,
  };
});
