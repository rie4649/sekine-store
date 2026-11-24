/* =====================================================================
   せきね ストア(Firestore)の鍵(版 11/23-1)
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

  // Firestore の部品がこわれた(INTERNAL ASSERTION FAILED)ときは、ページを開き直す(1分に1回まで)
  function isBroken(e){ var m = String((e && (e.message || e)) || ""); return /INTERNAL ASSERTION FAILED/i.test(m); }
  function recover(e){
    if (!isBroken(e)) return;
    var now = Date.now(), last = 0;
    try { last = +sessionStorage.getItem("sekineAuthReload") || 0; } catch(x){}
    if (now - last < 60000) return;   // 開き直したばかりなら、くり返さない
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

  var F = fb.firestore;
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
  window.sekineAuthVer = "版 11/23-1";
  window.sekineAuthReady = function(){ var g = gateOf({}); return g ? g.p : Promise.resolve(); };
})();
