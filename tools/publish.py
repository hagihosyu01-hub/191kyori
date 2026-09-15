#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
距離標アプリ：会社ごとの公開を1コマンドで行う

  191kyori フォルダで実行します。

    python tools/publish.py --new yamada-kensetsu          会社フォルダのひな形を作る
    python tools/publish.py yamada-kensetsu --check        中身の確認だけ
    python tools/publish.py yamada-kensetsu --build-only   dist/ に組み立てて zip も作る（手でアップロードする場合）
    python tools/publish.py yamada-kensetsu --dry-run      組み立てまで行い、公開のコマンドを表示するだけ
    python tools/publish.py yamada-kensetsu                確認 → 組み立て → Cloudflare Pages に公開
    python tools/publish.py --list                         会社の一覧

  会社フォルダ customers/<会社名>/ の中身
    data/kp.csv          距離標データ（必須。1列目 route に路線名。複数路線も1つのファイルでOK）
    data/settings.json   路線名・方面・工事名・送信先・名前など（必須）
    deploy.json          {"project": "kyori-〇〇"}  Cloudflare Pages のプロジェクト名（必須）
    files/               図面画像（map_01.webp など）。サイトの一番上にそのまま置かれます
    icon-192.png         その会社のアイコン（任意。無ければ共通のアイコン）

  customers/ と dist/ は公開リポジトリには上げません（.gitignore 済み）。
"""
import argparse
import csv
import datetime
import io
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CUSTOMERS = os.path.join(ROOT, 'customers')
DIST      = os.path.join(ROOT, 'dist')

# どの会社でも同じもの（プログラム本体と共通の絵）
CORE_FILES = [
    'index.html', 'service-worker.js', 'icon-192.png',
    'patrol_pothole.png', 'patrol_debris.png', 'patrol_tree-road.png',
    'patrol_tree-sight.png', 'patrol_guardrail.png', 'patrol_light.png',
]
REQUIRED  = ['routeName', 'areaName', 'upDirection', 'downDirection', 'workName', 'workNameFall', 'fileSuffix']
SLUG      = re.compile(r'^[a-z0-9][a-z0-9-]{0,57}$')
KP_LABEL  = re.compile(r'^(\d+)(?:-(\d+))?k(\d+)$')
GAS_URL   = re.compile(r'^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$')
BAD_CHARS = re.compile(r'[\\/:*?"<>|]')
PLACEHOLDER_FILE = 'ここに図面画像を入れる.txt'

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def read_text(path):
    """UTF-8（BOM付き可）で読めなければ、Excel保存の Shift_JIS として読む"""
    raw = open(path, 'rb').read()
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return raw.decode('cp932')


def is_placeholder(v):
    if isinstance(v, str):
        return '〇〇' in v
    if isinstance(v, list):
        return any(is_placeholder(x) for x in v)
    return False


# --------------------------------------------------------------------------
# 確認
# --------------------------------------------------------------------------
def check(name):
    """会社フォルダの中身を確かめる。(errors, warnings, info) を返す"""
    base = os.path.join(CUSTOMERS, name)
    errors, warns, info = [], [], {'name': name, 'base': base}

    if not SLUG.match(name):
        errors.append('会社フォルダ名は、半角の小文字・数字・ハイフンにしてください（例 yamada-kensetsu）')
    if not os.path.isdir(base):
        errors.append('会社フォルダがありません: customers/' + name + '（--new ' + name + ' で作れます）')
        return errors, warns, info

    # --- settings.json ---
    sp = os.path.join(base, 'data', 'settings.json')
    st = None
    if not os.path.isfile(sp):
        errors.append('data/settings.json がありません')
    else:
        try:
            st = json.loads(read_text(sp))
        except json.JSONDecodeError as e:
            errors.append('data/settings.json の書き方に誤りがあります（%d行目 %d文字目：%s）。" や , の付け忘れがないか確認してください'
                          % (e.lineno, e.colno, e.msg))
    if st is not None:
        missing = [k for k in REQUIRED if not st.get(k)]
        if missing:
            errors.append('data/settings.json に次の項目がありません／空です: ' + ', '.join(missing))
        ph = [k for k, v in st.items() if is_placeholder(v)]
        if ph:
            errors.append('data/settings.json の「〇〇」を書き換えてください: ' + ', '.join(ph))
        for k in ('routeName', 'fileSuffix', 'workName', 'workNameFall'):
            if isinstance(st.get(k), str) and BAD_CHARS.search(st[k]):
                errors.append('data/settings.json の %s に、ファイル名に使えない文字（\\ / : * ? " < > |）があります' % k)
        gas = st.get('gasUrl', '')
        if not gas:
            warns.append('gasUrl が空です（道路点検・落下物の送信は動きません。GASの設置後に入れてください）')
        elif not GAS_URL.match(gas):
            errors.append('gasUrl の形が違います（https://script.google.com/macros/s/…/exec の形にしてください）')
        users = st.get('patrolUsers')
        if users is None:
            warns.append('patrolUsers がありません（道路点検の名前は、画面に書いてある既定の名前になります）')
        elif not (isinstance(users, list) and users and all(isinstance(u, str) and u.strip() for u in users)):
            errors.append('patrolUsers は ["名前1", "名前2"] の形で、1人以上入れてください')
        if st.get('siteUrl') and not str(st['siteUrl']).startswith(('http://', 'https://')):
            errors.append('siteUrl は http:// か https:// で始めてください')
        info['settings'] = st

    # --- kp.csv ---
    kp = os.path.join(base, 'data', 'kp.csv')
    maps, labels, kp_labels = set(), [], []
    if not os.path.isfile(kp):
        errors.append('data/kp.csv がありません')
    else:
        rows = list(csv.reader(io.StringIO(read_text(kp))))
        head = [h.strip().lower() for h in rows[0]] if rows else []
        need = [c for c in ('label', 'lat', 'lng') if c not in head]
        if need:
            errors.append('data/kp.csv の1行目に ' + ', '.join(need) + ' がありません（1行目は route,label,lat,lng,url,map,x,y）')
        else:
            iL, iLat, iLng = head.index('label'), head.index('lat'), head.index('lng')
            iMap = head.index('map') if 'map' in head else -1
            bad = []
            for n, row in enumerate(rows[1:], start=2):
                if not any(c.strip() for c in row):
                    continue
                cell = lambda i: row[i].strip() if 0 <= i < len(row) else ''
                label = cell(iL)
                try:
                    lat, lng = float(cell(iLat)), float(cell(iLng))
                    ok = bool(label) and 20 <= lat <= 46 and 122 <= lng <= 154
                except ValueError:
                    ok = False
                if not ok:
                    bad.append(n)
                    continue
                labels.append(label)
                if KP_LABEL.match(label):
                    kp_labels.append(label)
                m = cell(iMap)
                if m:
                    maps.add(m.replace('\\', '/'))
            if bad:
                errors.append('data/kp.csv に読めない行があります（label が空、または緯度経度が日本の範囲外）: '
                              + ', '.join(str(x) for x in bad[:10]) + (' ほか%d行' % (len(bad) - 10) if len(bad) > 10 else '') + '行目')
            if not labels:
                errors.append('data/kp.csv に距離標が1件もありません')
            dup = len(labels) - len(set(labels))
            if dup:
                warns.append('data/kp.csv に同じ名前の行が %d 件あります（ずれの原因になるので確認してください）' % dup)
        info['count'] = len(labels)
        info['kp_count'] = len(kp_labels)
        if kp_labels:
            def key(l):
                g = KP_LABEL.match(l).groups()
                return (int(g[0]), int(g[1] or 0), int(g[2]))
            s = sorted(kp_labels, key=key)
            info['range'] = s[0] + ' 〜 ' + s[-1]

    # --- 図面画像 ---
    missing_maps = [m for m in sorted(maps) if not os.path.isfile(os.path.join(base, 'files', m))]
    if missing_maps:
        errors.append('kp.csv の map 列にある図面画像が files/ にありません: ' + ', '.join(missing_maps[:10])
                      + (' ほか%d件' % (len(missing_maps) - 10) if len(missing_maps) > 10 else ''))
    info['maps'] = len(maps)

    # --- deploy.json ---
    dp = os.path.join(base, 'deploy.json')
    if not os.path.isfile(dp):
        errors.append('deploy.json がありません（{"project": "kyori-' + name + '"} のように書きます）')
    else:
        try:
            project = json.loads(read_text(dp)).get('project', '')
        except json.JSONDecodeError:
            project = ''
            errors.append('deploy.json の書き方に誤りがあります')
        if project and not SLUG.match(project):
            errors.append('deploy.json の project は、半角の小文字・数字・ハイフンにしてください')
        elif not project:
            errors.append('deploy.json に project がありません')
        info['project'] = project

    info['icon'] = os.path.isfile(os.path.join(base, 'icon-192.png'))
    return errors, warns, info


def print_report(errors, warns, info):
    st = info.get('settings') or {}
    print('')
    print('■ ' + info['name'])
    if st:
        print('  路線・管内   : %s %s' % (st.get('routeName', ''), st.get('areaName', '')))
        print('  車線         : 上り＝%s ／ 下り＝%s' % (st.get('upDirection', ''), st.get('downDirection', '')))
        print('  道路点検の名前: %s' % ('、'.join(st.get('patrolUsers') or []) or '（既定のまま）'))
        print('  送信先（GAS）: %s' % ('設定済み' if st.get('gasUrl') else '未設定'))
    if 'count' in info:
        print('  距離標       : %d 点（うち距離標の形 %d 点）%s' % (info['count'], info.get('kp_count', 0),
                                                         ('　範囲 ' + info['range']) if info.get('range') else ''))
    print('  図面画像     : %d 枚' % info.get('maps', 0))
    if info.get('project'):
        print('  公開先       : https://%s.pages.dev' % info['project'])
    for w in warns:
        print('  ⚠ ' + w)
    for e in errors:
        print('  ✗ ' + e)
    if not errors:
        print('  ✓ 確認OK')


# --------------------------------------------------------------------------
# 組み立て
# --------------------------------------------------------------------------
def html_escape(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def build(info):
    name, base, st = info['name'], info['base'], info['settings']
    out = os.path.join(DIST, name)
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)

    for f in CORE_FILES:
        src = os.path.join(ROOT, f)
        if not os.path.isfile(src):
            raise SystemExit('共通ファイルが見つかりません: ' + f)
        shutil.copy2(src, os.path.join(out, f))

    title = st['routeName'] + st['areaName'] + '距離標表示'
    short = st['routeName'] + '距離標'

    # index.html：タブの名前とホーム画面に出る名前をその会社のものに
    p = os.path.join(out, 'index.html')
    html = io.open(p, encoding='utf-8', newline='').read()
    html, n1 = re.subn(r'<title>[^<]*</title>', '<title>' + html_escape(title) + '</title>', html, count=1)
    html, n2 = re.subn(r'(<meta name="apple-mobile-web-app-title" content=")[^"]*(")',
                       lambda m: m.group(1) + html_escape(short) + m.group(2), html, count=1)
    if n1 != 1 or n2 != 1:
        raise SystemExit('index.html の見出し部分が想定と違うため、組み立てを中止しました')
    io.open(p, 'w', encoding='utf-8', newline='').write(html)

    # service-worker.js：公開ごとに保存名を変えて、各スマホに確実に新しい版を届ける。
    # Cloudflare Pages は /index.html を / に転送するため、保存・予備には './' を使う
    p = os.path.join(out, 'service-worker.js')
    sw = io.open(p, encoding='utf-8', newline='').read()
    stamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
    sw, n = re.subn(r"const CACHE_NAME = '[^']*';", "const CACHE_NAME = 'kyori-%s-%s';" % (name, stamp), sw, count=1)
    if n != 1:
        raise SystemExit('service-worker.js の CACHE_NAME が見つからないため、組み立てを中止しました')
    sw = sw.replace("'index.html'", "'./'")
    io.open(p, 'w', encoding='utf-8', newline='').write(sw)

    # manifest.json：ホーム画面に追加したときの名前
    m = json.loads(read_text(os.path.join(ROOT, 'manifest.json')))
    m['short_name'] = short
    m['name'] = title
    m['start_url'] = './'
    io.open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8').write(
        json.dumps(m, ensure_ascii=False, indent=2) + '\n')

    # 会社ごとのもの
    if info.get('icon'):
        shutil.copy2(os.path.join(base, 'icon-192.png'), os.path.join(out, 'icon-192.png'))
    shutil.copytree(os.path.join(base, 'data'), os.path.join(out, 'data'))
    files = os.path.join(base, 'files')
    if os.path.isdir(files):
        shutil.copytree(files, out, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(PLACEHOLDER_FILE))

    # Cloudflare Pages 用：本体とデータは毎回確かめ直させる（更新がすぐ届くように）
    io.open(os.path.join(out, '_headers'), 'w', encoding='utf-8').write(
        '/\n  Cache-Control: no-cache\n'
        '/index.html\n  Cache-Control: no-cache\n'
        '/service-worker.js\n  Cache-Control: no-cache\n'
        '/manifest.json\n  Cache-Control: no-cache\n'
        '/data/*\n  Cache-Control: no-cache\n')

    # 手でアップロードする場合の zip
    zp = os.path.join(DIST, name + '.zip')
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for folder, _, names in os.walk(out):
            for fn in names:
                full = os.path.join(folder, fn)
                z.write(full, os.path.relpath(full, out).replace('\\', '/'))

    n_files = sum(len(fs) for _, _, fs in os.walk(out))
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(out) for f in fs)
    print('  ✓ 組み立て完了: dist/%s（%d ファイル、%.1f MB）／ 手で上げる用: dist/%s.zip'
          % (name, n_files, size / 1048576, name))
    return out


# --------------------------------------------------------------------------
# 公開（Cloudflare Pages）
# --------------------------------------------------------------------------
def run(cmd, capture=True):
    return subprocess.run(cmd, capture_output=capture, text=True, encoding='utf-8', errors='replace')


def deploy(out, project, dry_run=False):
    npx = shutil.which('npx')
    cmds = [
        ['npx', 'wrangler', 'pages', 'project', 'list'],
        ['npx', 'wrangler', 'pages', 'project', 'create', project, '--production-branch', 'main'],
        ['npx', 'wrangler', 'pages', 'deploy', out, '--project-name', project, '--branch', 'main', '--commit-dirty=true'],
    ]
    if dry_run:
        print('  （dry-run）公開は行いません。実行するコマンドは次のとおりです：')
        for c in cmds:
            print('    ' + ' '.join(c))
        return 0
    if not npx:
        print('  ✗ Node.js が見つかりません。公開には次の準備が1回だけ必要です：')
        print('    1) https://nodejs.org から「LTS」をインストール')
        print('    2) このフォルダで  npx wrangler login  を実行し、Cloudflare にログイン')
        print('  すぐに公開したい場合は、dist/ の zip を Cloudflare の画面（Workers & Pages → 作成 → Pages → アップロード）から上げられます')
        return 2

    r = run([npx, 'wrangler', 'pages', 'project', 'list'])
    if r.returncode != 0:
        print(r.stdout + r.stderr)
        print('  ✗ Cloudflare に接続できません。 npx wrangler login  を実行してから、もう一度試してください')
        return 2
    if project not in r.stdout:
        print('  … Cloudflare に新しいプロジェクト「%s」を作ります' % project)
        r = run([npx, 'wrangler', 'pages', 'project', 'create', project, '--production-branch', 'main'])
        if r.returncode != 0:
            print(r.stdout + r.stderr)
            print('  ✗ プロジェクトを作れませんでした（名前が他の人に使われている場合は deploy.json の project を変えてください）')
            return 2

    print('  … 公開しています')
    r = run([npx, 'wrangler', 'pages', 'deploy', out, '--project-name', project, '--branch', 'main',
             '--commit-dirty=true'], capture=False)
    if r.returncode != 0:
        print('  ✗ 公開に失敗しました（上のメッセージを確認してください）')
        return 2
    print('  ✓ 公開しました: https://%s.pages.dev' % project)
    print('    はじめての会社なら、Cloudflare の Zero Trust → Access で、見られる人（メールアドレス）を設定してください')
    return 0


# --------------------------------------------------------------------------
# 会社フォルダのひな形
# --------------------------------------------------------------------------
SETTINGS_TEMPLATE = {
    "routeName":     "R〇〇",
    "areaName":      "〇〇保守",
    "upDirection":   "〇〇方面",
    "downDirection": "〇〇方面",
    "shootToward":   "〇〇方面",
    "workName":      "〇〇kouji",
    "workNameFall":  "R〇〇kouji",
    "fileSuffix":    "〇〇",
    "gasUrl":        "",
    "siteUrl":       "",
    "siteLabel":     "",
    "patrolUsers":   ["〇〇", "〇〇"]
}

MEMO = """{name} の設置メモ

□ data/settings.json の「〇〇」をすべて書き換えた
□ data/kp.csv に距離標を入れた（Excel可。1行目 route,label,lat,lng,url,map,x,y）
□ 図面画像を files/ に入れた（kp.csv の map 列の名前と同じにする）
□ GASを設置して、gasUrl に …/exec のURLを入れた（設置手順書を参照）
□ python tools/publish.py {name} --check で ✓ 確認OK
□ python tools/publish.py {name} で公開
□ Cloudflare の Zero Trust → Access で、見られる人のメールアドレスを登録
□ 公開URL（https://{project}.pages.dev）をスマホで開いて、ホーム画面に追加
"""


def new(name):
    if not SLUG.match(name):
        raise SystemExit('会社フォルダ名は、半角の小文字・数字・ハイフンにしてください（例 yamada-kensetsu）')
    base = os.path.join(CUSTOMERS, name)
    if os.path.exists(base):
        raise SystemExit('すでにあります: customers/' + name)
    os.makedirs(os.path.join(base, 'data'))
    os.makedirs(os.path.join(base, 'files'))
    project = 'kyori-' + name
    io.open(os.path.join(base, 'data', 'settings.json'), 'w', encoding='utf-8', newline='').write(
        json.dumps(SETTINGS_TEMPLATE, ensure_ascii=False, indent=2).replace('\n', '\r\n') + '\r\n')
    io.open(os.path.join(base, 'data', 'kp.csv'), 'w', encoding='utf-8-sig', newline='').write(
        'route,label,lat,lng,url,map,x,y\r\n')
    shutil.copy2(os.path.join(ROOT, 'data', 'README.txt'), os.path.join(base, 'data', 'README.txt'))
    io.open(os.path.join(base, 'deploy.json'), 'w', encoding='utf-8').write(
        json.dumps({'project': project}, ensure_ascii=False, indent=2) + '\n')
    io.open(os.path.join(base, 'files', PLACEHOLDER_FILE), 'w', encoding='utf-8', newline='').write(
        'このフォルダに図面画像（map_01.webp など）を入れます。\r\nこのファイルは公開されません。\r\n')
    io.open(os.path.join(base, 'メモ.txt'), 'w', encoding='utf-8', newline='').write(
        MEMO.format(name=name, project=project).replace('\n', '\r\n'))
    print('作りました: customers/%s' % name)
    print('  次に data/settings.json と data/kp.csv を書き、files/ に図面画像を入れてください（メモ.txt に手順）')
    print('  書けたら:  python tools/publish.py %s --check' % name)


def list_customers():
    if not os.path.isdir(CUSTOMERS):
        print('まだ会社はありません（python tools/publish.py --new 会社名 で作れます）')
        return
    names = sorted(n for n in os.listdir(CUSTOMERS) if os.path.isdir(os.path.join(CUSTOMERS, n)))
    if not names:
        print('まだ会社はありません')
    for n in names:
        errors, warns, info = check(n)
        st = info.get('settings') or {}
        built = os.path.join(DIST, n)
        when = datetime.datetime.fromtimestamp(os.path.getmtime(built)).strftime('%Y/%m/%d %H:%M') if os.path.isdir(built) else '未'
        print('%-22s %-10s %5s点  組み立て:%s  %s' % (n, st.get('routeName', ''), info.get('count', 0), when,
                                                    '✓' if not errors else '✗ 要確認 %d件' % len(errors)))


def main():
    ap = argparse.ArgumentParser(description='距離標アプリ：会社ごとの公開')
    ap.add_argument('name', nargs='?', help='会社フォルダ名（customers/ の下）')
    ap.add_argument('--new', metavar='会社名', help='会社フォルダのひな形を作る')
    ap.add_argument('--list', action='store_true', help='会社の一覧')
    ap.add_argument('--check', action='store_true', help='確認だけ')
    ap.add_argument('--build-only', action='store_true', help='組み立てと zip 作成まで')
    ap.add_argument('--dry-run', action='store_true', help='組み立てて、公開のコマンドを表示するだけ')
    a = ap.parse_args()

    if a.new:
        new(a.new)
        return 0
    if a.list:
        list_customers()
        return 0
    if not a.name:
        ap.print_help()
        return 1

    errors, warns, info = check(a.name)
    print_report(errors, warns, info)
    if errors:
        print('\n直してから、もう一度実行してください。')
        return 1
    if a.check:
        return 0
    out = build(info)
    if a.build_only:
        return 0
    return deploy(out, info['project'], dry_run=a.dry_run)


if __name__ == '__main__':
    sys.exit(main())
