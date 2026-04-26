# 沖縄市循環バス 乗換案内

沖縄市循環バスのGTFS静的データをブラウザで読み込み、出発停留所・到着停留所・日時から、乗継を含む最短到着ルートと移動時間を表示する静的Webアプリです。

## 使い方

1. `index.html` をWebサーバー経由で開きます。
2. 出発停留所、到着停留所、利用日、出発時刻を入力します。
3. 「最短ルートを検索」を押します。

GitHub Pagesで公開すれば、iPhoneのSafariから開いて「ホーム画面に追加」できます。

## ローカル起動

```powershell
node server.js
```

ブラウザで `http://127.0.0.1:4173/` を開きます。

## データ

アプリ起動時に沖縄市循環バスのGTFS ZIPを取得して解析します。ブラウザやネットワークの制限で取得できない場合は、画面内の「データ更新・読み込み」からGTFS ZIPを手動で読み込めます。

公式情報:

- https://www.city.okinawa.okinawa.jp/k036-001/chiikikankyou/koukyoukoutsuu/shibus/25042.html
- https://www.transit.land/feeds/f-5000020472115~jp
