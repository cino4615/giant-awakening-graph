/**
 * 거대각성그래프 — 노드별 토론 백엔드 (Google Apps Script Web App)
 * ------------------------------------------------------------------
 * 데이터: 이 스크립트가 바인딩된 스프레드시트의 'comments' 시트
 * 보안/설정값은 코드가 아니라 [프로젝트 설정 > 스크립트 속성]에 저장합니다.
 *
 *   ADMIN_SECRET        (필수)  관리자 삭제/숨김용 비밀키
 *   RECAPTCHA_SECRET    (선택)  reCAPTCHA v3 비밀키. 없으면 검증 생략
 *   RECAPTCHA_MIN_SCORE (선택)  기본 0.5
 *   BANNED_WORDS        (선택)  쉼표로 구분한 금지어 추가 목록
 *
 * 배포: 새 배포 > 유형=웹 앱 > 실행 주체=나 > 액세스=모든 사용자 → /exec URL 사용
 * 시트 헤더는 자동 생성됩니다(빈 시트면 됩니다).
 */

var SHEET_NAME = 'comments';
var HEADERS = ['id', 'nodeId', 'parentId', 'nickname', 'body', 'createdAt', 'reports', 'hidden'];
var MAX_NICK = 20;
var MAX_BODY = 1000;
var REPORT_HIDE_THRESHOLD = 3;     // 신고 3회 누적 → 자동 숨김
var COOLDOWN_SECONDS = 8;          // 같은 clientId 연속 작성 쿨다운

// 기본 금지어(마스킹). 운영하며 BANNED_WORDS 속성으로 추가하세요.
var BASE_BANNED = ['시발','씨발','병신','개새끼','새끼','지랄','좆','존나','니미','боку'];

/* ============================== 라우팅 ============================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = p.callback || '';
  try {
    if (p.action === 'ping') return out_({ ok: true, pong: true }, cb);
    if (p.action === 'list') {
      var node = String(p.node || '');
      if (!node) return out_({ ok: false, error: 'node 필요' }, cb);
      return out_({ ok: true, node: node, comments: listComments_(node) }, cb);
    }
    return out_({ ok: false, error: 'unknown action' }, cb);
  } catch (err) {
    return out_({ ok: false, error: String(err) }, cb);
  }
}

function doPost(e) {
  var data = {};
  try { data = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (_) {}
  var cb = (e && e.parameter && e.parameter.callback) || '';
  try {
    switch (data.action) {
      case 'add':    return out_(addComment_(data), cb);
      case 'report': return out_(reportComment_(data), cb);
      case 'delete': return out_(adminMutate_(data, 'delete'), cb);
      case 'hide':   return out_(adminMutate_(data, 'hide'), cb);
      case 'unhide': return out_(adminMutate_(data, 'unhide'), cb);
      default:       return out_({ ok: false, error: 'unknown action' }, cb);
    }
  } catch (err) {
    return out_({ ok: false, error: String(err) }, cb);
  }
}

/* ============================== 기능 ============================== */

function listComments_(node) {
  var sh = getSheet_();
  var values = sh.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (String(r[1]) !== node) continue;        // nodeId
    if (r[7] === true || r[7] === 'TRUE') continue; // hidden 제외
    rows.push({
      id: String(r[0]),
      parentId: String(r[2] || ''),
      nickname: String(r[3]),
      body: String(r[4]),
      createdAt: String(r[5]),
      reports: Number(r[6]) || 0
    });
  }
  rows.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
  return rows;
}

function addComment_(data) {
  // 허니팟: 사람에게 안 보이는 필드. 채워져 있으면 봇.
  if (data.website) return { ok: false, error: 'spam' };

  var nickname = sanitizeLine_(String(data.nickname || '').trim());
  var body = String(data.body || '').trim();
  var nodeId = String(data.nodeId || '').trim();
  var parentId = String(data.parentId || '').trim();

  if (!nodeId) return { ok: false, error: '노드 정보 없음' };
  if (!nickname) nickname = '익명';
  if (nickname.length > MAX_NICK) nickname = nickname.slice(0, MAX_NICK);
  if (!body) return { ok: false, error: '내용을 입력하세요' };
  if (body.length > MAX_BODY) return { ok: false, error: '내용이 너무 깁니다(최대 ' + MAX_BODY + '자)' };
  if (hasURL_(body) || hasURL_(nickname)) return { ok: false, error: '링크는 등록할 수 없습니다' };

  // clientId 기반 쿨다운(가벼운 도배 방지)
  var cid = String(data.clientId || '').slice(0, 64);
  if (cid) {
    var cache = CacheService.getScriptCache();
    if (cache.get('cd_' + cid)) return { ok: false, error: '잠시 후 다시 시도해주세요' };
    cache.put('cd_' + cid, '1', COOLDOWN_SECONDS);
  }

  // reCAPTCHA v3 (설정된 경우에만)
  var rc = verifyRecaptcha_(data.recaptchaToken);
  if (!rc.ok) return { ok: false, error: rc.error || '검증 실패' };

  // 욕설 마스킹(거부 아님 — 레벨2)
  nickname = maskBanned_(nickname);
  body = maskBanned_(body);

  // 답글은 1단계까지만: parentId는 최상위 댓글이어야 함
  if (parentId && !isTopLevel_(parentId, nodeId)) parentId = '';

  var id = genId_();
  var createdAt = new Date().toISOString();
  getSheet_().appendRow([id, nodeId, parentId, nickname, body, createdAt, 0, false]);
  return { ok: true, comment: { id: id, parentId: parentId, nickname: nickname, body: body, createdAt: createdAt, reports: 0 } };
}

function reportComment_(data) {
  var id = String(data.id || '');
  if (!id) return { ok: false, error: 'id 필요' };
  var sh = getSheet_();
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === id) {
      var reports = (Number(values[i][6]) || 0) + 1;
      var hidden = reports >= REPORT_HIDE_THRESHOLD;
      sh.getRange(i + 1, 7).setValue(reports);         // reports
      if (hidden) sh.getRange(i + 1, 8).setValue(true); // hidden
      return { ok: true, reports: reports, hidden: hidden };
    }
  }
  return { ok: false, error: '대상 없음' };
}

function adminMutate_(data, mode) {
  if (!checkAdmin_(data.admin)) return { ok: false, error: '권한 없음' };
  var id = String(data.id || '');
  if (!id) return { ok: false, error: 'id 필요' };
  var sh = getSheet_();
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === id) {
      if (mode === 'delete') { sh.deleteRow(i + 1); return { ok: true, deleted: id }; }
      sh.getRange(i + 1, 8).setValue(mode === 'hide'); // hide=true / unhide=false
      return { ok: true, id: id, hidden: mode === 'hide' };
    }
  }
  return { ok: false, error: '대상 없음' };
}

/* ============================== 헬퍼 ============================== */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
  }
  return sh;
}

function isTopLevel_(parentId, nodeId) {
  var values = getSheet_().getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === parentId && String(values[i][1]) === nodeId) {
      return String(values[i][2] || '') === ''; // parent의 parentId가 비어있어야 최상위
    }
  }
  return false;
}

function verifyRecaptcha_(token) {
  var secret = prop_('RECAPTCHA_SECRET');
  if (!secret) return { ok: true };               // 미설정 시 통과
  if (!token) return { ok: false, error: '봇 검증 토큰 없음' };
  try {
    var resp = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'post',
      payload: { secret: secret, response: token },
      muteHttpExceptions: true
    });
    var j = JSON.parse(resp.getContentText());
    var min = Number(prop_('RECAPTCHA_MIN_SCORE') || '0.5');
    if (j.success && (typeof j.score !== 'number' || j.score >= min)) return { ok: true };
    return { ok: false, error: '봇으로 의심되어 차단되었습니다' };
  } catch (err) {
    return { ok: true };                           // 검증 서버 장애 시 사용자 막지 않음
  }
}

function checkAdmin_(given) {
  var secret = prop_('ADMIN_SECRET');
  return !!secret && String(given || '') === secret;
}

function bannedList_() {
  var extra = (prop_('BANNED_WORDS') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return BASE_BANNED.concat(extra);
}

function maskBanned_(text) {
  var list = bannedList_();
  for (var i = 0; i < list.length; i++) {
    if (!list[i]) continue;
    var re = new RegExp(list[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    text = text.replace(re, function (m) { return m[0] + repeat_('*', m.length - 1); });
  }
  return text;
}

function hasURL_(text) { return /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io|kr|co|me|xyz|shop|link))/i.test(text); }
function sanitizeLine_(s) { return s.replace(/[\r\n\t]+/g, ' '); }
function repeat_(c, n) { var s = ''; for (var i = 0; i < n; i++) s += c; return s; }
function genId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function out_(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
