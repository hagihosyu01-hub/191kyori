/**
 * 巡回点検「その他異常」用 GAS（Google Apps Script）追記コード
 * ----------------------------------------------------------------
 * フロント側(index.html)は、写真撮影後に以下のJSONをPOSTします：
 *   {
 *     type: "line_image",
 *     message: "📍距離標\n⚠️その他異常\n🕐日時\n👤氏名",
 *     kp, event, date, time, user,
 *     image: "(JPEGのbase64・本体部分のみ)",
 *     mimeType: "image/jpeg"
 *   }
 * 既存のテキスト送信(type:"line")はそのまま動きます。
 *
 * ★前提：LINE Messaging API（push）を使う構成。
 *   既にGASが動いているなら、token / 送信先IDは今お使いの値に合わせてください。
 *   既存のdoPostがある場合は「丸ごと置き換え」ず、下の line_image 分岐だけを
 *   既存のdoPostに移植するのが安全です。
 */

// ===== 設定（今お使いのGASの値に合わせる）=====
const CHANNEL_ACCESS_TOKEN = 'ここにLINEチャネルアクセストークン';
const TO = 'ここに送信先のグループID または ユーザーID';
// 画像保存用フォルダ（任意。空ならマイドライブ直下に保存）
const DRIVE_FOLDER_ID = '';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.type === 'line_image' && data.image) {
      // 写真あり：Driveに保存 → 公開URL → テキスト＋画像で送信
      const imageUrl = saveImageAndGetUrl(data.image, data.mimeType || 'image/jpeg');
      pushLine([
        { type: 'text',  text: data.message || 'その他異常' },
        { type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl }
      ]);
    } else {
      // 従来どおりテキストのみ
      pushLine([{ type: 'text', text: data.message || '' }]);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/** base64画像をDriveに保存し、LINEが読める公開URLを返す */
function saveImageAndGetUrl(base64, mimeType) {
  const bytes = Utilities.base64Decode(base64);
  const name  = 'patrol_' + new Date().getTime() + '.jpg';
  const blob  = Utilities.newBlob(bytes, mimeType, name);

  const folder = DRIVE_FOLDER_ID
    ? DriveApp.getFolderById(DRIVE_FOLDER_ID)
    : DriveApp.getRootFolder();

  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // LINEが直接画像として取得できるURL
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

/** LINE Messaging API でpush送信 */
function pushLine(messages) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify({ to: TO, messages: messages }),
    muteHttpExceptions: true
  });
}


/**
 * ================================================================
 *  R191萩保守　落下物写真アップロード（GAS側 追加コード）
 * ================================================================
 *  AAindex.html の「📷 カメラを起動（落下物）📷」から
 *  type: 'fallen_object' として3枚が1枚ずつ POST されてきます。
 *
 *  受信JSON（1リクエスト＝写真1枚）:
 *    {
 *      type:     'fallen_object',
 *      groupId:  'FO1730000000000_123',  // 3枚共通のID
 *      index:    1,                      // 1..3
 *      total:    3,
 *      stage:    '処理前' | '近景' | '処理後',
 *      fileName: 'R191_102k300_20260731_1430_1_処理前.jpg',
 *      kp:       '102k300',
 *      date:     '2026/07/31',
 *      time:     '14:30',
 *      user:     '担当者名（未選択なら空）',
 *      event:    '落下物',
 *      message:  'LINE用の本文',
 *      image:    '<base64>',
 *      mimeType: 'image/jpeg'
 *    }
 *
 *  【導入手順】
 *   1) 下の FALLEN_ROOT_FOLDER_ID に保存先フォルダのIDを入れる
 *      （DriveでフォルダのURL https://drive.google.com/drive/folders/★ここ★ ）
 *   2) 既存の doPost の分岐に fallen_object を1行追加（下の例を参照）
 *   3) 「デプロイ」→「デプロイを管理」→ 編集(鉛筆) →
 *      バージョン「新バージョン」→ デプロイ
 *      ※ URLは変わらないので AAindex.html 側の変更は不要
 * ================================================================
 */

// ★保存先の親フォルダID（空文字の場合はマイドライブ直下に自動作成）
var FALLEN_ROOT_FOLDER_ID = '';
// 親フォルダを自動作成する場合の名前
var FALLEN_ROOT_FOLDER_NAME = 'R191萩保守_落下物写真';

// ★LINEにも通知したい場合は true（既存の pushLineImage_ を使います）
var FALLEN_NOTIFY_LINE = false;


/**
 * 既存の doPost への追加例
 * ------------------------------------------------
 * function doPost(e) {
 *   var d = JSON.parse(e.postData.contents);
 *
 *   if (d.type === 'line')       { ...既存... }
 *   if (d.type === 'line_image') { ...既存... }
 *
 *   // ↓ この1行を追加
 *   if (d.type === 'fallen_object') { return handleFallenObject_(d); }
 *
 *   return ContentService.createTextOutput('ok');
 * }
 * ------------------------------------------------
 */


/** 落下物写真1枚を受け取ってDriveに保存する */
function handleFallenObject_(d) {
  try {
    var folder = getFallenGroupFolder_(d);

    var bytes = Utilities.base64Decode(d.image);
    var blob  = Utilities.newBlob(bytes, d.mimeType || 'image/jpeg', d.fileName || ('fallen_' + d.index + '.jpg'));
    var file  = folder.createFile(blob);

    file.setDescription(
      '距離標: ' + (d.kp || '') + '\n' +
      '工程: '   + (d.stage || '') + ' (' + d.index + '/' + d.total + ')\n' +
      '日時: '   + (d.date || '') + ' ' + (d.time || '') + '\n' +
      '担当: '   + (d.user || '')
    );

    // 3枚目が届いたタイミングでログ行を1行だけ追記（任意）
    if (Number(d.index) === Number(d.total)) {
      appendFallenLog_(d, folder);
    }

    // LINE通知（任意）
    if (FALLEN_NOTIFY_LINE && typeof pushLineImage_ === 'function') {
      pushLineImage_(d.message, file);
    }

    return ContentService.createTextOutput(JSON.stringify({
      ok: true, fileId: file.getId(), folderId: folder.getId()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    console.error('handleFallenObject_ error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({
      ok: false, error: String(err)
    })).setMimeType(ContentService.MimeType.JSON);
  }
}


/** groupId ごとのサブフォルダを取得（なければ作成） */
function getFallenGroupFolder_(d) {
  var root = getFallenRootFolder_();

  // 年月フォルダ（2026-07 など）で整理
  var ym = (d.date || '').replace(/\//g, '-').substring(0, 7) || 'unknown';
  var ymFolder = getOrCreateChildFolder_(root, ym);

  // 案件フォルダ：落下物_距離標_日付_時刻
  var name = '落下物_' + (d.kp || 'KP不明') + '_' +
             (d.date || '').replace(/\//g, '') + '_' +
             (d.time || '').replace(':', '');

  // 同名が既にある場合に備え groupId でロック的に一意化
  var props = PropertiesService.getScriptProperties();
  var key   = 'FO_' + d.groupId;
  var saved = props.getProperty(key);
  if (saved) {
    try { return DriveApp.getFolderById(saved); } catch (e) { /* 消えていたら作り直す */ }
  }
  var folder = ymFolder.createFolder(name);
  props.setProperty(key, folder.getId());
  return folder;
}


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


/**
 * 一覧用のスプレッドシートに1行追記（任意・不要ならこの関数の中身を空に）
 * 親フォルダ内に「落下物記録」シートを自動作成します。
 */
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
    d.date || '', d.time || '', d.kp || '', d.user || '', d.total || '',
    folder.getUrl()
  ]);
}
