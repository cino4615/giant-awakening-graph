/* 거대각성그래프 — 노드별 토론 오버레이 (정적 사이트 + Google Apps Script 백엔드)
 * 설정값은 아래 CFG만 바꾸면 됩니다. 백엔드 코드는 apps-script/Code.gs 참고. */
(function () {
  'use strict';

  var CFG = {
    API: 'https://script.google.com/macros/s/AKfycbyPNDvmn7XTfbkqieSvP696MbUbJ-WoiXN_jT8s2bGpaJzLyntHachxIUUzJnDLQYi42w/exec',
    RECAPTCHA: '6LcR6DMtAAAAAN1p5L74zBk5zpYjJnCtAY09nTG1',
    NODES_URL: '/nodes.json',
    REPORT_THRESHOLD: 3,
    CLICK_HOOK: true   // 캔버스 노드 클릭 시 런처를 "이 노드 토론"으로 전환(앱 상세패널 감지)
  };

  var DATA = null, groupById = {}, nodeById = {}, labelToNode = {}, groupLabels = {};
  var COUNTS = null, COUNTS_LOADED = false;
  var currentNodeId = null;
  var ADMIN = new URLSearchParams(location.search).get('admin') || '';
  var CLIENT = getClientId();
  var els = {};

  /* ----------------------------- 부트 ----------------------------- */
  ready(function () { fetchJSON(CFG.NODES_URL).then(init).catch(function (e) { console.warn('[gag] nodes load fail', e); }); });

  function init(data) {
    DATA = data;
    (data.groups || []).forEach(function (g) { groupById[g.id] = g; groupLabels[g.label] = 1; });
    (data.nodes || []).forEach(function (n, i) { n._i = i; nodeById[n.id] = n; labelToNode[n.label] = n; });
    buildUI();
    loadRecaptcha();
    loadCounts();                 // 모달 버튼·디렉터리 배지용 댓글 수 미리 로드
    if (CFG.CLICK_HOOK) watchAppPanel();
  }

  /* ----------------------------- UI 구성 ----------------------------- */
  function buildUI() {
    var launcher = h('button', { id: 'gag-launcher', title: '노드별 토론' },
      h('span', { class: 'gag-ic' }, '💬'), h('span', { class: 'gag-ltext' }, '토론'));
    launcher.addEventListener('click', onLauncher);

    var overlay = h('div', { id: 'gag-overlay' });
    overlay.addEventListener('click', closePanel);

    var panel = h('div', { id: 'gag-panel' });
    var head = h('div', { class: 'gag-head' });
    var back = h('button', { class: 'gag-back', title: '목록' }, '‹');
    back.style.display = 'none';
    back.addEventListener('click', showDirectory);
    var title = h('div', { class: 'gag-title' }, '노드별 토론');
    var close = h('button', { class: 'gag-close', title: '닫기' }, '×');
    close.addEventListener('click', closePanel);
    head.append(back, title, close);
    var body = h('div', { class: 'gag-body' });
    panel.append(head, body);

    document.body.append(launcher, overlay, panel);
    els = { launcher: launcher, launcherText: launcher.querySelector('.gag-ltext'), overlay: overlay, panel: panel, head: head, back: back, title: title, body: body };
  }

  function onLauncher() {
    var nid = els.launcher.dataset.node;
    if (nid && nodeById[nid]) openNode(nid);
    else { openPanel(); showDirectory(); }
  }
  function setLauncher(node) {
    if (node) { els.launcher.dataset.node = node.id; els.launcherText.textContent = '이 노드 토론'; els.launcher.classList.add('gag-node-mode'); }
    else { delete els.launcher.dataset.node; els.launcherText.textContent = '토론'; els.launcher.classList.remove('gag-node-mode'); }
  }
  function openPanel() { els.overlay.classList.add('open'); els.panel.classList.add('open'); }
  function closePanel() { els.overlay.classList.remove('open'); els.panel.classList.remove('open'); }

  /* ----------------------------- 디렉터리 ----------------------------- */
  function showDirectory() {
    currentNodeId = null;
    els.back.style.display = 'none';
    els.title.textContent = '노드별 토론';
    els.body.innerHTML = '';
    var wrap = h('div', { class: 'gag-search' });
    var input = h('input', { type: 'text', placeholder: '노드 검색…', autocomplete: 'off' });
    wrap.append(input);
    var listHost = h('div', { class: 'gag-dir' });
    els.body.append(wrap, listHost);
    function rerender() { renderList(listHost, input.value.trim().toLowerCase()); }
    input.addEventListener('input', rerender);
    rerender();
    loadCounts(function () { rerender(); });   // 열 때마다 최신 댓글 수 재조회 → 정렬·배지 갱신
    els.body.scrollTop = 0;
  }

  // 노드를 댓글 많은 순으로 평면 정렬해 표시(동률은 원래 순서)
  function renderList(host, q) {
    host.innerHTML = '';
    var nodes = (DATA.nodes || []).filter(function (n) {
      return !q || n.label.toLowerCase().indexOf(q) >= 0 || (n.note || '').toLowerCase().indexOf(q) >= 0;
    });
    nodes.sort(function (a, b) {
      var ca = (COUNTS && COUNTS[a.id]) || 0, cb = (COUNTS && COUNTS[b.id]) || 0;
      return cb !== ca ? cb - ca : (a._i || 0) - (b._i || 0);
    });
    if (!nodes.length) { host.append(h('div', { class: 'gag-empty' }, '검색 결과가 없습니다.')); return; }
    nodes.forEach(function (n) {
      var g = groupById[n.group] || {}, color = hsl(g), c = (COUNTS && COUNTS[n.id]) || 0;
      var item = h('div', { class: 'gag-item' + (c ? ' has' : '') },
        h('span', { class: 'dot', style: 'background:' + color }),
        h('div', { class: 'gag-itxt' }, h('span', { class: 'lbl' }, n.label), h('span', { class: 'gag-grp-s' }, g.label || '')),
        c > 0 ? h('span', { class: 'gag-cnt' }, '💬 ' + c) : h('span', { class: 'arr' }, '›'));
      item.addEventListener('click', function () { openNode(n.id); });
      host.append(item);
    });
  }

  /* ----------------------------- 노드 상세 + 토론 ----------------------------- */
  function openNode(nodeId) {
    var node = nodeById[nodeId];
    if (!node) return;
    currentNodeId = nodeId;
    openPanel();
    els.back.style.display = '';
    els.title.textContent = node.label;
    els.body.innerHTML = '';
    var g = groupById[node.group] || {};
    var color = hsl(g);
    var head = h('div', { class: 'gag-node-head' });
    head.append(h('span', { class: 'gag-chip' }, h('span', { class: 'dot', style: 'background:' + color }), g.label || '노드'));
    head.append(h('div', { class: 'gag-node-title' }, node.label));
    if (node.note) head.append(h('div', { class: 'gag-node-note' }, node.note));
    var count = h('div', { class: 'gag-count' }, '댓글 불러오는 중…');
    var list = h('div', { class: 'gag-list' }, h('div', { class: 'gag-loading' }, '⏳'));
    els.body.append(head, h('div', { class: 'gag-sep' }), count, list);
    els.body.append(buildForm(nodeId, '', function () { refresh(nodeId, count, list); }));
    els.body.scrollTop = 0;
    refresh(nodeId, count, list);
  }

  function refresh(nodeId, countEl, listEl) {
    apiList(nodeId).then(function (res) {
      if (currentNodeId !== nodeId) return;
      var comments = (res && res.comments) || [];
      countEl.textContent = '댓글 ' + comments.length + '개';
      if (COUNTS) COUNTS[nodeId] = comments.length;
      renderThread(listEl, nodeId, comments, countEl);
    }).catch(function () {
      if (currentNodeId !== nodeId) return;
      countEl.textContent = '댓글을 불러오지 못했습니다.'; listEl.innerHTML = '';
    });
  }

  function renderThread(listEl, nodeId, comments, countEl) {
    listEl.innerHTML = '';
    var tops = comments.filter(function (c) { return !c.parentId; });
    var childrenOf = {};
    comments.forEach(function (c) { if (c.parentId) (childrenOf[c.parentId] = childrenOf[c.parentId] || []).push(c); });
    if (!tops.length) { listEl.append(h('div', { class: 'gag-empty' }, '첫 번째 의견을 남겨보세요.')); return; }
    tops.forEach(function (c) {
      var card = commentCard(c, nodeId, countEl, listEl, false);
      var kids = childrenOf[c.id] || [];
      if (kids.length) {
        var rep = h('div', { class: 'gag-replies' });
        kids.forEach(function (k) { rep.append(commentCard(k, nodeId, countEl, listEl, true)); });
        (card.querySelector('.gag-main') || card).append(rep);
      }
      listEl.append(card);
    });
  }

  function commentCard(c, nodeId, countEl, listEl, isReply) {
    var nick = c.nickname || '익명';
    var card = h('div', { class: 'gag-c' + (isReply ? ' reply' : '') });
    var av = h('div', { class: 'gag-av', style: 'background:' + avatarColor(nick) }, avatarChar(nick));
    var main = h('div', { class: 'gag-main' });
    var meta = h('div', { class: 'meta' }, h('span', { class: 'nick' }, nick), h('span', { class: 'time' }, timeAgo(c.createdAt)));
    if (c.reports >= 1) meta.append(h('span', { class: 'gag-badge' }, '신고 ' + c.reports));
    var bubble = h('div', { class: 'gag-bubble' }, c.body);
    var acts = h('div', { class: 'acts' });
    if (!isReply) {
      var replyBtn = h('button', {}, '답글');
      replyBtn.addEventListener('click', function () { toggleReply(card, nodeId, c.id, countEl, listEl); });
      acts.append(replyBtn);
    }
    var rep = h('button', {}, '신고');
    rep.addEventListener('click', function () { doReport(c.id, nodeId, countEl, listEl); });
    acts.append(rep);
    if (ADMIN) {
      var del = h('button', { class: 'del' }, '삭제');
      del.addEventListener('click', function () { doDelete(c.id, nodeId, countEl, listEl); });
      acts.append(del);
    }
    main.append(meta, bubble, acts);
    card.append(av, main);
    return card;
  }

  function toggleReply(card, nodeId, parentId, countEl, listEl) {
    var host = card.querySelector('.gag-main') || card;
    var ex = host.querySelector(':scope > .gag-form.reply');
    if (ex) { ex.remove(); return; }
    host.append(buildForm(nodeId, parentId, function () { refresh(nodeId, countEl, listEl); }, true));
  }

  /* ----------------------------- 작성 폼 ----------------------------- */
  function buildForm(nodeId, parentId, onDone, isReply) {
    var form = h('div', { class: 'gag-form' + (isReply ? ' reply' : '') });
    var nick = h('input', { class: 'nick', type: 'text', placeholder: '닉네임(선택)', maxlength: '20' });
    var hp = h('input', { class: 'gag-hp', type: 'text', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    var ta = h('textarea', { placeholder: isReply ? '답글 달기…' : '의견을 남겨보세요…', maxlength: '1000' });
    var msg = h('div', { class: 'gag-msg' });
    var submit = h('button', { class: 'submit' }, isReply ? '답글 등록' : '등록');
    var row = h('div', { class: 'row' }, h('span', { class: 'hint' }, '링크·욕설은 자동 차단/마스킹됩니다'), submit);
    form.append(nick, hp, ta, row, msg);
    if (!isReply) form.append(h('div', { class: 'gag-recaptcha-note' },
      '이 사이트는 reCAPTCHA로 보호되며 Google ',
      link('https://policies.google.com/privacy', '개인정보처리방침'), document.createTextNode('과 '),
      link('https://policies.google.com/terms', '약관'), document.createTextNode('이 적용됩니다.')));

    submit.addEventListener('click', function () {
      var body = ta.value.trim();
      msg.className = 'gag-msg';
      if (!body) { msg.classList.add('err'); msg.textContent = '내용을 입력하세요.'; return; }
      if (/(https?:\/\/|www\.)/i.test(body)) { msg.classList.add('err'); msg.textContent = '링크는 등록할 수 없습니다.'; return; }
      submit.disabled = true; msg.textContent = '등록 중…';
      recaptcha('comment').then(function (token) {
        return apiPost({ action: 'add', nodeId: nodeId, parentId: parentId || '', nickname: nick.value.trim(), body: body, website: hp.value, clientId: CLIENT, recaptchaToken: token });
      }).then(function (res) {
        if (res && res.ok) { ta.value = ''; msg.className = 'gag-msg ok'; msg.textContent = '등록되었습니다.'; if (COUNTS) COUNTS[nodeId] = (COUNTS[nodeId] || 0) + 1; if (isReply) form.remove(); onDone(); }
        else { msg.className = 'gag-msg err'; msg.textContent = (res && res.error) || '등록에 실패했습니다.'; }
      }).catch(function () { msg.className = 'gag-msg err'; msg.textContent = '네트워크 오류. 잠시 후 다시 시도해주세요.'; })
        .then(function () { submit.disabled = false; });
    });
    return form;
  }

  function doReport(id, nodeId, countEl, listEl) {
    if (!confirm('이 댓글을 신고할까요? 신고가 ' + CFG.REPORT_THRESHOLD + '회 누적되면 자동으로 숨겨집니다.')) return;
    apiPost({ action: 'report', id: id }).then(function (res) {
      if (res && res.ok && res.hidden) alert('신고가 누적되어 숨김 처리되었습니다.');
      refresh(nodeId, countEl, listEl);
    });
  }
  function doDelete(id, nodeId, countEl, listEl) {
    if (!confirm('관리자: 이 댓글을 삭제할까요?')) return;
    apiPost({ action: 'delete', id: id, admin: ADMIN }).then(function (res) {
      if (!res || !res.ok) alert((res && res.error) || '삭제 실패');
      refresh(nodeId, countEl, listEl);
    });
  }

  /* -------------------- 앱 상세패널 감지 → 런처 컨텍스트 전환 -------------------- */
  function watchAppPanel() {
    var raf = null, last = null;
    new MutationObserver(function () { if (raf) return; raf = requestAnimationFrame(function () { raf = null; sync(); }); })
      .observe(document.body, { childList: true, subtree: true, characterData: true });

    function findPanel(prev) {           // 상세 모달 = 위로 올라가며 만나는 첫 position:absolute
      var el = prev;
      while (el && el !== document.body) { if (getComputedStyle(el).position === 'absolute') return el; el = el.parentElement; }
      return null;
    }
    function findNode(panel) {            // 모달 안에서 첫 '노드 라벨'(그룹 라벨 제외)이 선택 노드 제목
      var all = panel.querySelectorAll('div,span');
      for (var i = 0; i < all.length; i++) {
        var t = (all[i].textContent || '').trim();
        if (all[i].children.length <= 1 && labelToNode[t] && !groupLabels[t]) return labelToNode[t];
      }
      return null;
    }
    function injectOpenBtn(panel, node) {
      var cnt = (COUNTS && COUNTS[node.id]) || 0;
      var txt = '💬 이 노드 토론방' + (cnt ? ' · ' + cnt : '');
      var btn = panel.querySelector('#gag-open-btn');
      if (btn) { if (btn.dataset.node !== node.id) { btn.dataset.node = node.id; btn.textContent = txt; } return; }
      btn = h('button', { id: 'gag-open-btn', class: 'gag-open-btn' }, txt);
      btn.dataset.node = node.id;
      btn.addEventListener('click', function (e) { e.stopPropagation(); openNode(btn.dataset.node); });
      var header = panel.children[0];
      if (header && header.insertAdjacentElement) header.insertAdjacentElement('afterend', btn);
      else panel.appendChild(btn);
    }
    function sync() {
      try {
        var prev = document.querySelector('[title^="이전"]');
        if (!prev) { if (last !== null) { last = null; setLauncher(null); } return; }
        var panel = findPanel(prev);
        if (!panel) return;
        var node = findNode(panel);
        if (!node) return;
        if (node.id !== last) { last = node.id; setLauncher(node); }
        injectOpenBtn(panel, node);
      } catch (e) { /* 감지 실패해도 런처/디렉터리는 정상 동작 */ }
    }
  }

  /* ----------------------------- 네트워크 ----------------------------- */
  function apiList(nodeId) { return jsonp({ action: 'list', node: nodeId }); }
  function apiCounts() { return jsonp({ action: 'counts' }); }
  function loadCounts(cb) {
    apiCounts().then(function (r) { COUNTS = (r && r.ok && r.counts) || {}; COUNTS_LOADED = true; cb && cb(); })
      .catch(function () { COUNTS = {}; COUNTS_LOADED = true; cb && cb(); });
  }
  function apiPost(payload) {
    return fetch(CFG.API, { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.text(); })
      .then(function (txt) { try { return JSON.parse(txt); } catch (e) { return { ok: true, _unverified: true }; } })
      .catch(function () { return { ok: true, _unverified: true }; });
  }
  function jsonp(params) {
    return new Promise(function (resolve, reject) {
      var cb = 'gagcb_' + Math.floor(performance.now() * 1000) + '_' + (jsonp._n = (jsonp._n || 0) + 1);
      var s = document.createElement('script');
      var to = setTimeout(function () { cleanup(); reject(new Error('timeout')); }, 12000);
      function cleanup() { clearTimeout(to); delete window[cb]; if (s.parentNode) s.parentNode.removeChild(s); }
      window[cb] = function (data) { cleanup(); resolve(data); };
      var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
      s.src = CFG.API + '?' + qs + '&callback=' + cb;
      s.onerror = function () { cleanup(); reject(new Error('jsonp error')); };
      document.body.appendChild(s);
    });
  }

  /* ----------------------------- reCAPTCHA v3 ----------------------------- */
  function loadRecaptcha() {
    if (!CFG.RECAPTCHA || window.grecaptcha) return;
    var s = document.createElement('script');
    s.src = 'https://www.google.com/recaptcha/api.js?render=' + CFG.RECAPTCHA;
    s.async = true; document.head.appendChild(s);
  }
  function recaptcha(action) {
    if (!CFG.RECAPTCHA || !window.grecaptcha || !grecaptcha.execute) return Promise.resolve('');
    return new Promise(function (resolve) {
      grecaptcha.ready(function () { grecaptcha.execute(CFG.RECAPTCHA, { action: action }).then(resolve, function () { resolve(''); }); });
    });
  }

  /* ----------------------------- 유틸 ----------------------------- */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === 'class') el.className = attrs[k]; else if (k === 'style') el.style.cssText = attrs[k]; else el.setAttribute(k, attrs[k]); }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null) continue; el.append(c.nodeType ? c : document.createTextNode(c)); }
    return el;
  }
  function link(href, text) { return h('a', { href: href, target: '_blank', rel: 'noopener' }, text); }
  function hsl(g) { return g && g.hue != null ? 'hsl(' + g.hue + ',' + (g.sat || 60) + '%,' + (g.light || 62) + '%)' : '#8b84ff'; }
  function avatarColor(name) { var n = name || '익명', s = 0; for (var i = 0; i < n.length; i++) s = (s * 31 + n.charCodeAt(i)) % 360; return 'linear-gradient(135deg,hsl(' + s + ',55%,58%),hsl(' + ((s + 35) % 360) + ',55%,46%))'; }
  function avatarChar(name) { var n = (name || '익').trim(); return n ? n.charAt(0).toUpperCase() : '익'; }
  function timeAgo(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return '방금'; if (s < 3600) return Math.floor(s / 60) + '분 전';
    if (s < 86400) return Math.floor(s / 3600) + '시간 전'; if (s < 2592000) return Math.floor(s / 86400) + '일 전';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }
  function getClientId() {
    try { var k = 'gag_cid', v = localStorage.getItem(k); if (!v) { v = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(k, v); } return v; }
    catch (e) { return 'c' + Math.random().toString(36).slice(2); }
  }
  function fetchJSON(u) { return fetch(u).then(function (r) { return r.json(); }); }
  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
})();
