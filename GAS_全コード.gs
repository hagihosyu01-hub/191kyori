/**https://script.google.com/macros/s/AKfycbwHrB72SG8wkN9sf5cRvl7MuOSWaZ_o3TkZj2N7TcuJqPStSXZA4D3gMyEHkTN7JvVp/exec
 * ==========================================================================
 *  R191萩保守　距離標アプリ用　Google Apps Script（全コード）
 * ==========================================================================
 *  index.html から fetch(PATROL_GAS_URL) で送られてくる POST を受け取ります。
 *
 *  受け付ける type：
 *    'line'           … 巡回点検の事象ボタン（テキストのみLINE送信）
 *    'line_image'     … 巡回点検「その他異常」（写真1枚＋テキスト）
 *    'fallen_object'  … 落下物（処理前／近景／処理後 の3枚をDriveへ保存）
 *
 *  ⚠️ 重要
 *  すでに動いている巡回点検用のスクリプトがある場合は、
 *  このファイルで丸ごと置き換えず、
 *  「■ 落下物」セクション（handleFallenObject_ 以降）だけをコピーして、
 *  既存の doPost に下の1行を足すのが安全です。
 *      if (d.type === 'fallen_object') { return handleFallenObject_(d); }
 *
 *  【デプロイ手順】
 *   1) 下の CONFIG を埋める
 *   2) 右上「デプロイ」→「デプロイを管理」→ 鉛筆アイコン
 *      → バージョン「新バージョン」→「デプロイ」
 *      ※「新しいデプロイ」だとURLが変わってしまうので注意
 *   3) 初回はDrive／外部通信の承認ダイアログが出るので許可する
 * ==========================================================================
 */


/* =========================================================================
 * ■ CONFIG（ここだけ書き換える）
 * ========================================================================= */

// LINE Messaging API のチャネルアクセストークン（長期）
var LINE_TOKEN = '9fmr+uwmiruL++Onv3HEy05SZTOjMgMCBCe/dFUSoxNU5fEkQ+76BVzSuiMKBzgW2mVOoUczzjCcyUY/SY+WqIn5D3qBl/I/+/QEC+/AOUmScn6etRz7TMjXMUu/eUvhkbRVuvx8aqoZy/8e1rA4gQdB04t89/1O/w1cDnyilFU=';

// 送信先。グループID（Cxxxx…）／ユーザーID（Uxxxx…）／ルームID（Rxxxx…）
var LINE_TO = 'Cae94a10d5c875b659f039cfeedb3f7e3';

// 落下物写真の保存先フォルダID
// （DriveでフォルダのURL https://drive.google.com/drive/folders/★ここ★ ）
// 空にしておくとマイドライブ直下に下の名前で自動作成されます
var FALLEN_ROOT_FOLDER_ID = '';
var FALLEN_ROOT_FOLDER_NAME = 'R191萩保守_落下物写真';

// 落下物をアップしたときLINEにも通知するか
var FALLEN_NOTIFY_LINE = true;

// 落下物の一覧スプレッドシートを作る／追記するか
var FALLEN_WRITE_LOG = true;


/* =========================================================================
 * ■ 入口（doPost）
 * ========================================================================= */

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);

    if (d.type === 'line')           { return handleLineText_(d); }
    if (d.type === 'line_image')     { return handleLineImage_(d); }
    if (d.type === 'fallen_object')  { return handleFallenObject_(d); }

    return json_({ ok: false, error: 'unknown type: ' + d.type });

  } catch (err) {
    console.error('doPost error: ' + err);
    return json_({ ok: false, error: String(err) });
  }
}

// 動作確認用（ブラウザでURLを開くと ok と出る）
function doGet() {
  return ContentService.createTextOutput('ok');
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/* =========================================================================
 * ■ 巡回点検：テキストのみ
 * ========================================================================= */

function handleLineText_(d) {
  pushLineText_(d.message);
  return json_({ ok: true });
}


/* =========================================================================
 * ■ 巡回点検「その他異常」：写真1枚＋テキスト
 *    写真はDriveに保存し、LINEには画像メッセージを送る
 * ========================================================================= */

function handleLineImage_(d) {
  var folder = getOrCreateChildFolder_(getFallenRootFolder_(), 'その他異常');

  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  var name  = 'R191_' + sanitize_(d.kp || 'KP不明') + '_' + stamp + '.jpg';

  var blob = Utilities.newBlob(
    Utilities.base64Decode(d.image),
    d.mimeType || 'image/jpeg',
    name
  );
  var file = folder.createFile(blob);

  pushLineImageOrText_(d.message, file);
  return json_({ ok: true, fileId: file.getId() });
}


/* =========================================================================
 * ■ 落下物：処理前／近景／処理後 の3枚をDriveへ保存
 *    index.html から1枚ずつ、計3回POSTされてきます
 * ========================================================================= */

function handleFallenObject_(d) {
  try {
    var folder = getFallenGroupFolder_(d);

    var blob = Utilities.newBlob(
      Utilities.base64Decode(d.image),
      d.mimeType || 'image/jpeg',
      d.fileName || ('fallen_' + d.index + '.jpg')
    );
    var file = folder.createFile(blob);

    file.setDescription(
      '距離標: ' + (d.kp || '') + '\n' +
      '工程: '   + (d.stage || '') + ' (' + d.index + '/' + d.total + ')\n' +
      '日時: '   + (d.date || '') + ' ' + (d.time || '') + '\n' +
      '担当: '   + (d.user || '')
    );

    // 3枚目（最後）が届いたときだけ、ログ追記とLINE通知を1回行う
    if (Number(d.index) === Number(d.total)) {
      if (FALLEN_WRITE_LOG)    { appendFallenLog_(d, folder); }
      if (FALLEN_NOTIFY_LINE)  { notifyFallen_(d, folder); }
    }

    return json_({ ok: true, fileId: file.getId(), folderId: folder.getId() });

  } catch (err) {
    console.error('handleFallenObject_ error: ' + err);
    return json_({ ok: false, error: String(err) });
  }
}


/** groupId ごとの案件フォルダを取得（なければ作成） */
function getFallenGroupFolder_(d) {
  var props = PropertiesService.getScriptProperties();
  var key   = 'FO_' + d.groupId;
  var saved = props.getProperty(key);
  if (saved) {
    try { return DriveApp.getFolderById(saved); } catch (e) { /* 消えていたら作り直す */ }
  }

  var root = getFallenRootFolder_();

  // 年月フォルダ（2026-07 など）で整理
  var ym = (d.date || '').replace(/\//g, '-').substring(0, 7) || 'unknown';
  var ymFolder = getOrCreateChildFolder_(root, ym);

  // 案件フォルダ：落下物_距離標_日付_時刻
  var name = '落下物_' + (d.kp || 'KP不明') + '_' +
             (d.date || '').replace(/\//g, '') + '_' +
             (d.time || '').replace(':', '');

  var folder = ymFolder.createFolder(name);
  props.setProperty(key, folder.getId());
  return folder;
}


/** 落下物3枚がそろったらLINEに通知（フォルダのリンク付き） */
function notifyFallen_(d, folder) {
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var msg = '📍 ' + (d.kp || '') + '\n' +
            '🧱 落下物（処理前・近景・処理後 3枚）\n' +
            '🕐 ' + (d.date || '') + ' ' + (d.time || '') +
            (d.user ? '\n👤 ' + d.user : '') + '\n' +
            '📂 ' + folder.getUrl();
  pushLineText_(msg);
}


/** 一覧用スプレッドシートに1行追記 */
function appendFallenLog_(d, folder) {
  var root = getFallenRootFolder_();
  var name = '落下物記録';
  var it   = root.getFilesByName(name);
  var ss;

  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create(name);
    var f = DriveApp.getFileById(ss.getId());
    root.addFile(f);
    DriveApp.getRootFolder().removeFile(f);
    ss.getActiveSheet().appendRow(['日付', '時刻', '距離標', '担当者', '枚数', 'フォルダURL']);
  }

  ss.getActiveSheet().appendRow([
    d.date || '', d.time || '', d.kp || '', d.user || '', d.total || '', folder.getUrl()
  ]);
}


/* =========================================================================
 * ■ Drive 共通
 * ========================================================================= */

function getFallenRootFolder_() {
  if (FALLEN_ROOT_FOLDER_ID) {
    return DriveApp.getFolderById(FALLEN_ROOT_FOLDER_ID);
  }
  var it = DriveApp.getFoldersByName(FALLEN_ROOT_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FALLEN_ROOT_FOLDER_NAME);
}

function getOrCreateChildFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function sanitize_(s) {
  return String(s).replace(/[^a-zA-Z0-9_\-]/g, '');
}


/* =========================================================================
 * ■ LINE 送信
 * ========================================================================= */

/** テキストを送る */
function pushLineText_(message) {
  return linePush_([{ type: 'text', text: String(message).substring(0, 4900) }]);
}

/**
 * 画像を送る。DriveのファイルをリンクURLで画像メッセージにする。
 * LINE側が画像URLを受け付けなかった場合はテキストだけ送る（送信漏れ防止）。
 */
function pushLineImageOrText_(message, file) {
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var url = 'https://drive.usercontent.google.com/download?id=' + file.getId() + '&export=view';

  var res = linePush_([
    { type: 'text',  text: String(message).substring(0, 4900) },
    { type: 'image', originalContentUrl: url, previewImageUrl: url }
  ]);

  if (res.getResponseCode() !== 200) {
    console.warn('画像送信に失敗したためテキストのみ送信: ' + res.getContentText());
    linePush_([{ type: 'text', text: String(message) + '\n🖼 ' + file.getUrl() }]);
  }
  return res;
}

function linePush_(messages) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + LINE_TOKEN },
    payload: JSON.stringify({ to: LINE_TO, messages: messages }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error('LINE push error ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  return res;
}


/* =========================================================================
 * ■ 動作テスト（エディタ上で関数を選んで実行して確認）
 * ========================================================================= */

function testLine() {
  pushLineText_('テスト送信です（R191萩保守）');
}

function testFolder() {
  var f = getFallenRootFolder_();
  console.log('保存先フォルダ: ' + f.getName() + ' / ' + f.getUrl());
}
