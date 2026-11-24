/* =====================================================================
   せきね ストア(Firestore)の鍵(版 11/24-2)
   11/24-2: 読み取り回数を数えて、1日1枚の記録(readStats/日付)にアプリ・コレクションごとに書く(5分ごと)
            見る画面: https://rie4649.github.io/sekine-store/readstats.html
   11/24-1: 自動で開き直すのは30分に1回まで(開き直しのたびに全部を読み直して、読み取り回数がふくらまないように)
   11/23-1: スマホで「INTERNAL ASSERTION FAILED: Unexpected state」が出たら、ページを自動で開き直す。
            しばらく閉じていた画面に戻ったときは、ログインの札(トークン)を新しくしてから読む
   ・アプリを開くと、裏で「匿名ログイン」をする(使う人の操作は何も変わらない)
   ・ログインが終わるまで、Firestore を読む・書くのを少しだけ待たせる
     (ルールを「ログインした人だけ」にしても、最初の読み込みが失敗しないように)
   ・匿名ログインがまだオンになっていないとき・通信が悪いときは、8秒で今までどおり動く
   ・sekine-store 以外のプロジェクト(単価の sekine-tanka など)には何もしない
   使い方: firebase-firestore-compat.js のすぐ後に 1行
     <script src="https://rie4649.github.io/sekine-store/sekine-auth.js"></script>
   ===================================================================== */
(function(){
  var fb = window.firebase;
  if (!fb || !fb.firestore || !fb.firestore.Firestore || fb.__sekineAuth) return;
  fb.__sekineAuth = true;
  var PROJECT = "sekine-store";

  // ログインの部品(auth)がないページは、同じ版のものを読み込む
  var authLoaded = (fb.auth ? Promise.resolve() : new Promise(function(res){
    var s = document.createElement("script");
    s.src = "https://www.gstatic.com/firebasejs/" + (fb.SDK_VERSION || "10.12.2") + "/firebase-auth-compat.js";
    s.onload = res; s.onerror = function(){ console.warn("ログインの部品を読み込めませんでした"); res(); };
    (document.head || document.documentElement).appendChild(s);
  }));

  var gates = {};     // アプリの名前ごとに「ログイン済み」を覚える
  function gateFor(name){
    var g = gates[name];
    if (g) return g;
    g = gates[name] = { ready: false, p: null };
    g.p = new Promise(function(res){
      var done = false, finish = function(){ if (!done){ done = true; g.ready = true; res(); } };
      setTimeout(finish, 8000);   // 8秒たったら先へ進む
      authLoaded.then(function(){
        try {
          var auth = fb.app(name).auth();
          if (auth.currentUser) return finish();
          var un = auth.onAuthStateChanged(function(u){
            try { un(); } catch(e){}
            if (u) return finish();
            auth.signInAnonymously().then(finish).catch(function(e){
              console.warn("匿名ログインできませんでした(sekine-store の Authentication で匿名をオンにしてください)", e && e.code);
              finish();
            });
          });
        } catch(e){ console.warn("ログインできませんでした", e); finish(); }
      });
    });
    return g;
  }

  // 呼び出し元(db・コレクション・ドキュメント・まとめ書き)から、どのアプリかを調べる
  function appOf(o){
    try {
      var a = o.app || (o.firestore && o.firestore.app) ||
              (o._delegate && (o._delegate._firestore || o._delegate.firestore) && (o._delegate._firestore || o._delegate.firestore).app);
      if (a && a.name) return a;
    } catch(e){}
    return null;
  }
  function gateOf(o){
    var a = appOf(o);
    if (a){
      if (!a.options || a.options.projectId !== PROJECT) return null;   // 別のプロジェクトは待たない
      return gateFor(a.name);
    }
    // 分からないときは sekine-store のアプリ全部を待つ
    var list = (fb.apps || []).filter(function(x){ return x.options && x.options.projectId === PROJECT; }).map(function(x){ return gateFor(x.name); });
    if (!list.length) return null;
    return { ready: list.every(function(g){ return g.ready; }), p: Promise.all(list.map(function(g){ return g.p; })) };
  }

  // Firestore の部品がこわれた(INTERNAL ASSERTION FAILED)ときは、ページを開き直す(30分に1回まで)
  function isBroken(e){ var m = String((e && (e.message || e)) || ""); return /INTERNAL ASSERTION FAILED/i.test(m); }
  function recover(e){
    if (!isBroken(e)) return;
    var now = Date.now(), last = 0;
    try { last = +sessionStorage.getItem("sekineAuthReload") || 0; } catch(x){}
    if (now - last < 1800000) return;   // 開き直したばかりなら、くり返さない
    try { sessionStorage.setItem("sekineAuthReload", String(now)); } catch(x){}
    console.warn("Firestore がこわれたので、ページを開き直します", e && e.message);
    setTimeout(function(){ location.reload(); }, 300);
  }
  window.addEventListener("unhandledrejection", function(ev){ recover(ev.reason); });
  window.addEventListener("error", function(ev){ recover(ev.error || ev.message); });
  function watch(p){ if (p && typeof p.then === "function") p.then(null, function(e){ recover(e); }); return p; }

  // 「待ってから実行」に包む(ログイン済みならすぐ実行)
  function wrapAsync(proto, m){
    var o = proto && proto[m]; if (!o || o.__sekine) return;
    var w = function(){
      var g = gateOf(this);
      if (!g || g.ready) return watch(o.apply(this, arguments));
      var self = this, args = arguments;
      return watch(g.p.then(function(){ return o.apply(self, args); }));
    };
    w.__sekine = true; proto[m] = w;
  }
  // onSnapshot(見張り)は、ログイン後に登録。止める関数はすぐ返す
  function wrapSnap(proto){
    var o = proto && proto.onSnapshot; if (!o || o.__sekine) return;
    var w = function(){
      var args = Array.prototype.slice.call(arguments), n = 0;
      for (var i = 0; i < args.length; i++) if (typeof args[i] === "function" && ++n === 2){   // 2つ目の関数＝エラーのとき。こわれたら開き直す
        args[i] = (function(f){ return function(e){ recover(e); return f.apply(this, arguments); }; })(args[i]); break;
      }
      var g = gateOf(this);
      if (!g || g.ready) return o.apply(this, args);
      var self = this, stop = null, cancelled = false;
      g.p.then(function(){ if (!cancelled) stop = o.apply(self, args); });
      return function(){ cancelled = true; if (stop) { try { stop(); } catch(e){} } };
    };
    w.__sekine = true; proto.onSnapshot = w;
  }

  /* ===== 読み取り回数を数える(版 11/24-2) =====
     Firestore の料金の数え方に合わせて、ざっくり数える
     ・コレクションを読む … 返ってきた件数(0件でも1回)
     ・ドキュメントを読む … 1回
     ・見張り(onSnapshot) … 最初は全部の件数、そのあとは変わった件数
     ・端末に残っていた分(キャッシュ)は数えない */
  var RS = { pages:{}, cols:{}, pc:{}, hours:{}, total:0, app:null };
  window.sekineReadStats = RS;
  function jst(){ return new Date(Date.now() + 9*3600000); }
  function key(s){ return String(s || "?").replace(/^\/+/, "").replace(/\./g, "_").replace(/\//g, "\uFF0F").slice(0, 120) || "?"; }
  var PAGE = key(location.pathname.replace(/\/$/, "/index.html"));
  function addRead(app, col, n){
    try {
      if (!n || !app || !app.options || app.options.projectId !== PROJECT) return;
      RS.app = app.name; RS.total += n;
      var c = key(String(col || "?").split("/")[0]), h = String(jst().getUTCHours());
      RS.pages[PAGE] = (RS.pages[PAGE] || 0) + n;
      RS.cols[c] = (RS.cols[c] || 0) + n;
      RS.pc[PAGE + "\uFF20" + c] = (RS.pc[PAGE + "\uFF20" + c] || 0) + n;
      RS.hours[h] = (RS.hours[h] || 0) + n;
    } catch(e){}
  }
  function colOfQuery(q, snap){
    try { if (q.path) return q.path; } catch(e){}
    try { if (snap && snap.docs && snap.docs[0]) return snap.docs[0].ref.parent.path; } catch(e){}
    try { var p = q._delegate._query.path; return p.segments ? p.segments.slice(p.offset || 0).join("/") : String(p); } catch(e){}
    return "?";
  }
  function fromCache(snap){ try { return !!(snap && snap.metadata && snap.metadata.fromCache); } catch(e){ return false; } }
  function countLayer(){
    var QP = F.Query && F.Query.prototype, DP = F.DocumentReference && F.DocumentReference.prototype;
    if (QP && QP.get && !QP.get.__cnt){ var qg = QP.get; QP.get = function(){ var self = this;
      return qg.apply(this, arguments).then(function(snap){ if (!fromCache(snap)) addRead(appOf(self), colOfQuery(self, snap), snap.size || 1); return snap; }); }; QP.get.__cnt = true; }
    if (DP && DP.get && !DP.get.__cnt){ var dg = DP.get; DP.get = function(){ var self = this;
      return dg.apply(this, arguments).then(function(snap){ if (!fromCache(snap)) addRead(appOf(self), self.parent && self.parent.path, 1); return snap; }); }; DP.get.__cnt = true; }
    function snapLayer(P, isQuery){
      if (!P || !P.onSnapshot || P.onSnapshot.__cnt) return;
      var os = P.onSnapshot;
      P.onSnapshot = function(){
        var self = this, args = Array.prototype.slice.call(arguments), first = true;
        function count(snap){ try {
          if (fromCache(snap)) return;
          var n = isQuery ? (first ? (snap.size || 1) : snap.docChanges().length) : 1;
          first = false;
          addRead(appOf(self), isQuery ? colOfQuery(self, snap) : (self.parent && self.parent.path), n);
        } catch(e){} }
        for (var i = 0; i < args.length; i++){
          if (typeof args[i] === "function"){ var f = args[i]; args[i] = function(snap){ count(snap); return f.apply(this, arguments); }; break; }
          if (args[i] && typeof args[i].next === "function"){ var ob = args[i], nx = ob.next;
            args[i] = { next:function(snap){ count(snap); return nx.apply(ob, arguments); }, error: ob.error && ob.error.bind(ob), complete: ob.complete && ob.complete.bind(ob) }; break; }
        }
        return os.apply(this, args);
      };
      P.onSnapshot.__cnt = true;
    }
    snapLayer(QP, true); snapLayer(DP, false);
  }
  // 5分ごと・画面を閉じるときに、その日の記録へ足し算で書く(書くのは1回で1件)
  function flush(){
    try {
      if (!RS.total || !RS.app) return;
      var inc = F.FieldValue && F.FieldValue.increment; if (!inc) return;
      var data = { total: inc(RS.total), p:{}, c:{}, pc:{}, h:{}, last: Date.now() };
      Object.keys(RS.pages).forEach(function(k){ data.p[k] = inc(RS.pages[k]); });
      Object.keys(RS.cols).forEach(function(k){ data.c[k] = inc(RS.cols[k]); });
      Object.keys(RS.pc).forEach(function(k){ data.pc[k] = inc(RS.pc[k]); });
      Object.keys(RS.hours).forEach(function(k){ data.h[k] = inc(RS.hours[k]); });
      var name = RS.app;
      RS.pages = {}; RS.cols = {}; RS.pc = {}; RS.hours = {}; RS.total = 0;
      fb.app(name).firestore().collection("readStats").doc(jst().toISOString().slice(0, 10)).set(data, { merge:true })
        .catch(function(e){ console.warn("読み取り回数の記録を書けませんでした", e && e.code); });
    } catch(e){}
  }
  setInterval(flush, 300000);
  document.addEventListener("visibilitychange", function(){ if (document.hidden) flush(); });
  window.addEventListener("pagehide", flush);

  var F = fb.firestore;
  countLayer();
  wrapAsync(F.Query && F.Query.prototype, "get");
  wrapSnap(F.Query && F.Query.prototype);
  ["get", "set", "update", "delete"].forEach(function(m){ wrapAsync(F.DocumentReference && F.DocumentReference.prototype, m); });
  wrapSnap(F.DocumentReference && F.DocumentReference.prototype);
  wrapAsync(F.CollectionReference && F.CollectionReference.prototype, "add");
  wrapAsync(F.WriteBatch && F.WriteBatch.prototype, "commit");
  wrapAsync(F.Firestore && F.Firestore.prototype, "runTransaction");

  // しばらく(5分以上)閉じていた画面に戻ったら、ログインの札を新しくし終わるまで読むのを待つ
  var hiddenAt = 0;
  document.addEventListener("visibilitychange", function(){
    if (document.hidden){ hiddenAt = Date.now(); return; }
    if (!hiddenAt || Date.now() - hiddenAt < 300000){ hiddenAt = 0; return; }
    hiddenAt = 0;
    Object.keys(gates).forEach(function(name){
      var g = gates[name]; if (!g.ready) return;
      var u = null; try { u = fb.app(name).auth().currentUser; } catch(e){}
      if (!u || !u.getIdToken) return;
      g.ready = false;
      g.p = new Promise(function(res){
        var done = false, fin = function(){ if (!done){ done = true; g.ready = true; res(); } };
        setTimeout(fin, 8000);
        u.getIdToken().then(fin, fin);
      });
    });
  });

  // ページを開いたら、すぐログインを始めておく(アプリができてから)
  function warm(){
    (fb.apps || []).forEach(function(a){ if (a.options && a.options.projectId === PROJECT) gateFor(a.name); });
  }
  setTimeout(warm, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", warm);
  window.sekineAuthVer = "版 11/24-2";
  window.sekineAuthReady = function(){ var g = gateOf({}); return g ? g.p : Promise.resolve(); };
})();
