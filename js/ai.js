// 人と同じ規則で考える：engine の roll・stay・moveAlong・pick だけで指す。道は engine.paths（目の数ちょうどの道すべて）から選ぶ。
// サイコロの先の目・出来事は見ない。見るのは盤の上の公開の情報（誰がどの品を持つか・残っている品・目的地・自分のチップ）だけ
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory;
  else root.JintoriAI = factory;
})(this, function (E) {
  "use strict";
  const LEVELS = ["やさしい", "ふつう", "つよい"];
  // 強さごとの考え方
  // risk・riskW：色が動く見込み（つよい）。抜くのに要る重み（重み＝コスト＝要るチップ）と、相手（自分）がその県に貯めたチップの差で見る。
  // 差が risk 枚ふえるごとに見込みは半分。自分の色の県は 1−riskW×奪われる見込み、人の色の県は −(1−riskW×奪える見込み)
  // lock：（risk が無いとき）もう動かない県（残りの品を全部取られても色が変わらない）を重く見る
  // store：取らずに貯めたチップの見込み（次の品のコストにどれだけ近いか × その品で増える点）
  // pot：着いた県のまわりに、次の手で取れる県が多いか　dest：目的地への近さ　noise：揺らぎ
  // buy：取り方 best＝取る重み（品の組）を点で比べる・高い品で抜くこともある／max＝払えるだけ重みを大きく（品の組で）／all＝払えるだけ安い順に取る／rand＝でたらめな順に払えるだけ（高い品から払ってしまうこともある）
  const STYLE = {
    "やさしい": { alloc: "rand", rand: 0.1, lock: 0, store: 0, pot: 0, dest: 0, noise: 1, rstay: 0.05, buy: "rand" },
    "ふつう":   { alloc: "simple", rand: 0,   lock: 0, store: 0.2, pot: 0, dest: 0, noise: 0.3, buy: "max" },
    "つよい":   { alloc: "best", rand: 0,   risk: 2, riskW: 0.2, store: 0.5, pot: 0.05, dest: 0.15, noise: 0, stay: true, buy: "best" },
  };
  const ADDS = g => { const C = g.P.chips; return [...new Set([0, C.pass, C.stop, C.dest])]; };

  function weights(g, me) { // 人の色を一県減らす重み：2人なら1。3人以上は先頭の人を重く
    const w = {}, cnt = g.players.map(pl => E.countOf(g, pl.i)), lead = Math.max(...g.players.filter(pl => pl.i !== me.i).map(pl => cnt[pl.i]));
    for (const pl of g.players) w[pl.i] = g.players.length === 2 ? 1 : 0.6 + (cnt[pl.i] === lead ? 0.4 : 0);
    return w;
  }
  // 県ひとつぶんの点（自分が重み W ぶん取ったあと。色は取った品のコストの合計＝重みで比べる）。同数なら tie=last は取った自分の色、tie=keep はいまの色の人のまま
  // 重み＝コストなので、払ったチップの数だけ重みが増える。r＝残りの品の重みの合計
  function prefScore(g, me, p, W, S, w, R) {
    const c = g.cnt[p], r = R - W;
    let o = g.owner[p];
    const mine = c[me.i] + W;
    let other = 0;
    for (const pl of g.players) if (pl.i !== me.i) other = Math.max(other, c[pl.i]);
    if (W > 0 && (mine > other || (mine === other && (g.P.tie !== "keep" || o === undefined || o === me.i)))) o = me.i;
    if (o === undefined) return 0;
    if (S.risk) { // つよい：色が動く見込み。抜くのに要る重み（＝要るチップ）と、相手（自分）がその県に貯めたチップの差で見る
      const chance = (j, need) => need > r ? 0 : Math.pow(0.5, Math.max(0, need - g.chips[p][j]) / S.risk);
      if (o === me.i) { let t = 0; for (const pl of g.players) if (pl.i !== me.i) t = Math.max(t, chance(pl.i, mine - c[pl.i] + 1)); return 1 - S.riskW * t; }
      return -w[o] * (1 - S.riskW * chance(me.i, c[o] - mine + 1));
    }
    if (o === me.i) return 1 + (mine - other > r ? S.lock : 0);
    const oc = c[o];
    let next = mine; for (const pl of g.players) if (pl.i !== o) next = Math.max(next, c[pl.i] + (pl.i === me.i ? W : 0));
    return -w[o] - (oc - next > r ? S.lock : 0);
  }
  // 県 p の見立て：買える品で作れる重み W ごとの品の組（同じ重みなら品の多い組）・W ごとの点・残りの品のいちばん安いコスト
  function prefInfo(g, me, p, S, w) {
    const buy = E.takable(g, p), all = E.free(g, p), R = all.reduce((a, id) => a + E.costOf(g, id), 0);
    const sets = [[]];
    for (const id of buy) { const c = E.costOf(g, id); for (let W = sets.length - 1; W >= 0; W--) if (sets[W] && (!sets[W + c] || sets[W + c].length < sets[W].length + 1)) sets[W + c] = sets[W].concat(id); }
    const sc = sets.map((x, W) => x ? prefScore(g, me, p, W, S, w, R) + 0.02 * x.length : undefined);
    const min = all.length ? Math.min(...all.map(id => E.costOf(g, id))) : 0;
    return { sets, sc, min };
  }
  // チップ c 枚を持って県に来たときの、いちばん良い取り方（重み W・点）。取らずに残したチップは store の見込みで数える
  function bestTake(g, S, I, c, maxW = Infinity) {
    let bW = 0, bv = -Infinity;
    for (let W = 0; W < I.sc.length && W <= maxW && W <= c; W++) {
      if (I.sc[W] === undefined) continue;
      let v = I.sc[W];
      if (S.store && I.min) {
        let nx = W + 1; while (nx < I.sc.length && I.sc[nx] === undefined) nx++;
        const gain = Math.max(0.1, nx < I.sc.length ? (I.sc[nx] - I.sc[W]) / (nx - W) * I.min : 0.3);
        v += S.store * Math.min((c - W) / I.min, 1) * gain;
      }
      if (v > bv) { bv = v; bW = W; }
    }
    return { W: bW, v: bv };
  }
  // 各県に a 枚撒いた（そして取れるだけ取った）ときの点の増え方
  function deltas(g, S) {
    const me = E.cur(g), w = weights(g, me), d = {}, info = {};
    for (const p of E.PREFS) {
      if (!E.free(g, p).length) { d[p] = {}; for (const a of ADDS(g)) d[p][a] = 0; continue; } // 撒けない県
      const I = info[p] = prefInfo(g, me, p, S, w), c0 = g.chips[p][me.i], base = bestTake(g, S, I, c0, 0).v; // いま（取らずに貯めているだけ）の見込み
      d[p] = {}; for (const a of ADDS(g)) d[p][a] = bestTake(g, S, I, c0 + a).v - base;
    }
    const pot = {}, st = g.P.chips.stop;
    if (S.pot) for (const a of E.PREFS) { let v = 0; for (const q of E.PREFS) { const k = E.DIST[a][q]; if (k >= 1 && k <= 4 && d[q][st] > 0) v += d[q][st] / k; } pot[a] = v; }
    const D = { d, me, pot, w, info, base: {} };
    for (const p in info) D.base[p] = bestTake(g, S, info[p], g.chips[p][me.i], 0).v;
    return D;
  }
  // 県 p に a 枚置いた（そして取れるだけ取った）ときの点の増え方
  const val = (g, S, D, p, a) => D.info[p] ? bestTake(g, S, D.info[p], g.chips[p][D.me.i] + a).v - D.base[p] : 0;
  // ふつう＝道の順に「いちばん安い品にあと何枚」を満たせるだけ満たし、余りは着いた県（無ければ最後の県）へ。やさしい＝1枚ずつでたらめな県へ
  function allocPlan(g, S, D, ps, N) {
    const out = {}; for (const p of ps) out[p] = 0;
    if (!ps.length) return { counts: out, v: 0 };
    if (S.alloc === "rand") { for (let k = 0; k < N; k++) out[ps[Math.floor(g.rand() * ps.length)]]++; }
    else if (S.alloc === "simple") {
      let left = N;
      for (const p of ps) { const I = D.info[p]; if (!I || !I.min) continue; const need = Math.max(1, I.min - g.chips[p][D.me.i]); if (need <= left) { out[p] += need; left -= need; } }
      out[ps[ps.length - 1]] += left;
    } else {
      const V = ps.map(p => { const r = []; for (let a = 0; a <= N; a++) r.push(val(g, S, D, p, a)); return r; });
      let best = [0], ch = []; for (let t = 1; t <= N; t++) best.push(-Infinity);
      for (let i = 0; i < ps.length; i++) {
        const nb = Array(N + 1).fill(-Infinity), c = Array(N + 1).fill(0);
        for (let t = 0; t <= N; t++) for (let a = 0; a <= t; a++) if (best[t - a] > -Infinity && best[t - a] + V[i][a] > nb[t]) { nb[t] = best[t - a] + V[i][a]; c[t] = a; }
        best = nb; ch.push(c);
      }
      let t = N; for (let i = ps.length - 1; i >= 0; i--) { out[ps[i]] = ch[i][t]; t -= ch[i][t]; }
      return { counts: out, v: best[N] };
    }
    let v = 0; for (const p of ps) v += val(g, S, D, p, out[p]);
    return { counts: out, v };
  }
  const allocOf = (g, path) => ({ ps: path.filter(p => E.free(g, p).length), N: path.length + (path[path.length - 1] === g.dest ? g.P.allocDest : 0) });
  function pathScore(g, S, D, path) {
    const C = g.P.chips;
    let s = 0;
    const end = path[path.length - 1], atDest = end === g.dest;
    if (g.P.alloc) { const A = allocOf(g, path); s += allocPlan(g, S, D, A.ps, A.N).v; }
    else {
      for (let k = 0; k < path.length - 1; k++) s += D.d[path[k]][C.pass];
      s += D.d[end][atDest ? C.dest : C.stop];
    }
    if (S.dest && g.dest) s += S.dest * (E.DIST[D.me.pos][g.dest] - (atDest ? 0 : E.DIST[end][g.dest]));
    if (S.pot) s += S.pot * (D.pot[end] - D.pot[D.me.pos]);
    return s;
  }
  const bestOf = (g, S, D, n) => { let b = -Infinity; for (const pa of E.paths(D.me.pos, n)) { const v = pathScore(g, S, D, pa); if (v > b) b = v; } return b; };

  // 道の候補：目が6までは全部。サイコロ2つで7以上のときは数が多すぎるので、道をでたらめに伸ばした2,000本から選ぶ
  function candidates(g, from, n) {
    if (n <= 6) return E.paths(from, n);
    const out = [], seen = new Set();
    for (let k = 0; k < 6000 && out.length < 2000; k++) {
      const path = [], used = new Set([from]); let u = from;
      while (path.length < n) { const nx = E.NB[u].filter(v => !used.has(v)); if (!nx.length) break; u = nx[Math.floor(g.rand() * nx.length)]; used.add(u); path.push(u); }
      if (path.length === n) { const key = path.join(); if (!seen.has(key)) { seen.add(key); out.push(path); } }
    }
    return out;
  }
  const styleOf = (level, style) => Object.assign({}, STYLE[level] || STYLE["ふつう"], style || {});
  // 振るか、とどまるか
  function decide(g, level, style) {
    const S = styleOf(level, style);
    if (E.cur(g).dice2) return "roll"; // 道がひらいた次の手は振る（とどまるとサイコロ2つが消える）
    if (S.rstay && g.rand() < S.rstay) return "stay"; // やさしい：ときどき気まぐれにとどまる
    const D = deltas(g, S), st = g.P.alloc ? val(g, S, D, D.me.pos, g.P.allocStay) : D.d[D.me.pos][g.P.chips.stop];
    if (!S.stay) return st >= 1 ? "stay" : "roll"; // ふつう：とどまれば色が取れるときだけとどまる
    let ev = 0;
    for (let n = 1; n <= g.P.dice; n++) { const b = bestOf(g, S, D, n); ev += (b === -Infinity ? 0 : b) / g.P.dice; }
    return st > ev ? "stay" : "roll";
  }
  // 振ったあと、道を選ぶ（＝チップを撒く先を選ぶ）
  function choosePath(g, level, style) {
    if (!g.options.length) return [];
    const S = styleOf(level, style), all = candidates(g, E.cur(g).pos, E.steps(g));
    if (!all.length) return g.options.length ? E.paths(E.cur(g).pos, E.steps(g))[0] : []; // でたらめに伸ばして届かなかったとき
    if (g.rand() < S.rand) return all[Math.floor(g.rand() * all.length)];
    const D = deltas(g, S);
    let best = null, bv = -Infinity;
    for (const pa of all) {
      const v = pathScore(g, S, D, pa) + S.noise * g.rand();
      if (v > bv) { bv = v; best = pa; }
    }
    return best;
  }
  // 選ぶ板で品を選ぶ。県の中の品は色の上ではどれも1つなので、取るなら安い順（同じコストの中は揺らぎで）。
  // つよい：取る数を点で決める（取らずに貯めた方がよければ貯める）／ふつう：払えるだけ取る／やさしい：でたらめな順に、ときどき見送る
  function choosePicks(g, level, style) {
    const S = styleOf(level || E.cur(g).level, style), me = E.cur(g), w = weights(g, me), out = [];
    for (const x of g.pick) {
      if (S.buy === "best" || S.buy === "max") { const I = prefInfo(g, me, x.pref, S, w); let W = Math.min(x.chips, I.sets.length - 1); if (S.buy === "best") W = bestTake(g, S, I, x.chips).W; else while (!I.sets[W]) W--; out.push(...I.sets[W]); continue; } // 重みで選んだ品の組（高い品で抜くこともある）
      const ids = x.ids.map(id => [id, x.cost[id], g.rand()]);
      if (S.buy === "rand") ids.sort((a, b) => a[2] - b[2]); else ids.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
      let left = x.chips;
      for (const [id, c] of ids) if (c <= left) { out.push(id); left -= c; }
    }
    return out;
  }
  // 行事：次の目的地を選ぶ。やさしいはでたらめ。ほかは「着いてチップ dest 枚を撒いたときの点」から近さを引いて一番の県
  function chooseDest(g, level, style) {
    const c = g.choices;
    if (level === "やさしい") return c[Math.floor(g.rand() * c.length)];
    const S = styleOf(level, style), D = deltas(g, S);
    let best = c[0], bv = -Infinity;
    for (const p of c) { const v = D.d[p][g.P.chips.dest] - 0.15 * E.DIST[D.me.pos][p] + S.noise * g.rand(); if (v > bv) { bv = v; best = p; } }
    return best;
  }
  function chooseAlloc(g, level, style) {
    const S = styleOf(level || E.cur(g).level, style);
    return allocPlan(g, S, deltas(g, S), g.allocTo, g.allocN).counts;
  }
  // 一手まるごと（sim と画面で使う）。返り値は engine の手の記録
  function play(g, level, style) {
    let rec = decide(g, level, style) === "stay" ? E.stay(g) : (E.roll(g), E.moveAlong(g, choosePath(g, level, style)));
    if (g.phase === "alloc") rec = E.allocate(g, chooseAlloc(g, level, style));
    if (g.phase === "pick") rec = E.pick(g, choosePicks(g, level, style));
    if (g.phase === "dest") rec = E.setDest(g, chooseDest(g, level, style));
    return rec;
  }
  return { LEVELS, STYLE, decide, choosePath, choosePicks, chooseDest, chooseAlloc, play };
});
