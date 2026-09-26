距離標アプリ：会社ごとの公開のしくみ

■ 考え方
  プログラム本体（index.html など）は全社共通。
  会社ごとに違うもの（距離標・設定・図面画像）だけを customers/<会社名>/ に置き、
  1コマンドで組み立てて、その会社専用のURL（Cloudflare Pages）に公開します。

    customers/yamada-kensetsu/     ← 会社ごとのフォルダ（公開リポジトリには上げない）
      data/kp.csv                    距離標
      data/settings.json             路線名・方面・工事名・送信先・道路点検の名前
      files/                         図面画像（map_01.webp など）
      deploy.json                    公開先の名前 {"project": "kyori-yamada-kensetsu"}
      icon-192.png                   会社ごとのアイコン（任意）
    ..\191距離標作業用\dist\yamada-kensetsu\  ← 組み立て結果（自動で作られる。191kyori の外）

■ 最初に1回だけ（このパソコンで）
  1) Node.js の「LTS」をインストール（https://nodejs.org）
  2) 191kyori フォルダで  npx wrangler login  を実行し、Cloudflare にログイン

■ 新しい会社を追加するとき
  python tools/publish.py --new yamada-kensetsu
    → customers/yamada-kensetsu/ ができる。中の メモ.txt の順に埋めていく
  python tools/publish.py yamada-kensetsu --check
    → ✓ 確認OK になるまで直す
  python tools/publish.py yamada-kensetsu
    → 組み立てて公開。https://kyori-yamada-kensetsu.pages.dev
  最後に Cloudflare の Zero Trust → Access で、見られる人（社員のメール）を登録

■ プログラムを直したとき（全社に配る）
  python tools/publish.py 会社名   を会社ごとに実行（どの会社も同じコマンド）

■ Node.js が使えないとき
  python tools/publish.py 会社名 --build-only
    → 191距離標作業用\dist\会社名.zip ができるので、Cloudflare の画面
      （Workers & Pages → 作成 → Pages → アセットをアップロード）から上げる

■ 注意
  ・customers/ と dist/ は .gitignore で公開リポジトリに上げないようにしています。
  ・組み立て結果（dist）は、アップロードに混ざらないよう 191kyori の外の
    C:\00Claude_sagyou\191距離標作業用\dist\ に作ります。
    パソコンの故障に備えて、customers/ は別の場所（社内の共有フォルダなど）にも控えてください。
  ・萩（R191）の本番は、今までどおり GitHub Pages（data/ フォルダ）で動いています。
