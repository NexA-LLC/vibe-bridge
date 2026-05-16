# AGENTS.md


このリポジトリで作業するエージェント／コントリビューター向けガイドです。

## 原則
- DRY / KISS / YAGNI を徹底し、変更は最小差分で行う。
- 不明点や前提不足は推測せず、質問して確認する。


この `vibe-bridge/` は VibeBridge のワークスペース（`apps/*`, `packages/*`）です。


## TODO 管理
- 正本は `todos.jsonl`（プロジェクトルート）とする。
  - 1行=1件（JSON Lines）。
  - `id` は UUIDv7。
  - `deps` は依存する TODO の `id` 配列（推測で付けない）。
- 旧 Markdown TODO は廃止し、`todos.jsonl` のみ運用する。

### `todos.jsonl` のスキーマ（最小）
- 必須: `id`, `state`, `group`, `text`
- 任意: `deps`, `parentId`
- 例:
  - `{"id":"019b...","state":"open","group":"...","text":"...","deps":[]}`


## 原則
- 変更は最小差分（影響範囲を明確にする）。
- 不明点や前提不足は推測せず、確認する。

## Workspace
- 変更対象（`apps/*` / `packages/*`）と影響範囲を明示する。


## ID / UUID ポリシー

- **UUID は v7 必須**（時系列で並ぶIDにする）
- **禁止**: `crypto.randomUUID()`（v4）を新規に使う
- **実装**: サーバ側でIDを生成する場合は `src/lib/server/uuid.ts` の `uuidv7()` を使う
- **混在**: 既存の v4 が残っていてもOK（段階的に v7 へ移行する）

## レイアウト/ドキュメント
- 画面/コンポーネント等のレイアウト共有は ASCII アート（固定幅テキスト）で行う（必要に応じて）。
- ASCII レイアウトは、必要に応じて `ditaa` で画像化できるよう **ditaa互換の記法**（`+ - | / \\` 等）で記述し、罫線のUnicode文字（ボックスドローイング等）は避ける（参考: https://github.com/stathissideris/ditaa）。
- 画面仕様がある場合は `docs/screens/` に置き、画面遷移は `docs/screen-flow.md` にまとめる（無い場合は新設してOK）。
- 画面遷移図は **Mermaid** で記述する（`docs/screen-flow.md`）。ノード/画面名はプロジェクト内で統一し、正本は `docs/screens/README.md`（または `docs/screen-catalog.md`）に置く（無い場合は新設してOK）。
  - ルール（最小）: Mermaid のノードIDは `ScreenId`（英数字+PascalCase推奨）で固定し、表示ラベル側に画面名とルート（例: `Home["ホーム /[locale]/home"]`）を書く。
  - `docs/screens/` 配下の Markdown のパスは **実際のURL（ルート）と一致**させる（例: `/ja/shiftpay` → `docs/screens/shiftpay.md`）。`/[locale]` や `/[tenantId]` 等の動的セグメントは docs 側では省略してよい。

## 連携/問い合わせ
- 問い合わせ/サポートの一次受付は Caseflow。Flowlog の導線は Caseflow API へ送信し、`externalRef` と参照リンクで繋ぐ。
- Flowlog/Caseflow は独立プロダクト（問い合わせの正本は Caseflow）。詳細は `../flow-common/docs/ecosystem.md` を正本にする。

## 安全/権限
- 破壊的操作・外部ネットワーク・秘匿情報の取り扱いが絡む場合は、事前に人間へ確認する。

## ローカル/プロキシ環境（メモ）
- Cloudflare Tunnel + Nginx reverse proxy でローカル公開する運用がある。
- `scripts/deploy/nginx.flowapps.conf` は `/flowlog` -> `127.0.0.1:4001` への転送例。
- `BETTER_AUTH_URL` / `NEXT_PUBLIC_BETTER_AUTH_URL` は外部URL + `/flowlog` を含める。

## サーバーログの場所（メモ）
- `pnpm dev` / `pnpm dev:docker`: 起動中のターミナルに出る stdout/stderr（Docker は `docker compose logs -f`）。
- launchd: `__FLOWLOG_DIR__/logs/stdout.log` / `__FLOWLOG_DIR__/logs/stderr.log`（`scripts/deploy/flowlog.plist.template` を参照）。
- Nginx: `scripts/deploy/nginx.flowapps.conf` にログ先の指定が無いので、実際の出力先は環境側の `nginx.conf` を確認する。

## Database / Postgres

- 現状の `vibe-bridge` は Drizzle schema / Drizzle migration scripts を持たない。`apps/api` は `PLAN_STORAGE_BACKEND=postgres` の場合に `pg` で既存 table を利用するだけで、runtime DDL は行わない。
- AI エージェントは DB コマンド、手動 SQL / DDL / DML、本番 DB write を実行してはならない。
- Postgres の schema 変更が必要になった場合は、先に Drizzle schema / migration 設定と scratch/dev scripts を追加し、上位 `AGENTS.md` の DB opt-in ルールに従うこと。
- 追加すべき scripts の最低ライン:
  - `pnpm run db:generate:dev`
  - `pnpm run db:migrate:dev`
  - `pnpm run db:reset:scratch`
  - `pnpm run db:migrate:scratch`
- 上記 scripts が実装され、repo の `AGENTS.md` で明示 opt-in されるまで、AI は migration 生成/適用を行わない。

## コミュニケーション（重要）
- 誤解させたとか混乱させたとか言い訳しない. 間違ったことを伝えたなら何を間違ったのか,何も理解していないかなど正直に話す

## SOUL.md
- `SOUL.md` is the project source of truth for identity, principles, constraints, and evolution policy.
- When local optimizations conflict with long-term direction, follow `SOUL.md`.
- Any `SOUL.md` change must be human-reviewed before merge.
