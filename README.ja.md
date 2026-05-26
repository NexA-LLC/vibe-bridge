# Vibe Bridge（日本語）

Vibe Bridge は、社内サービス（FlowAlign など）から「やってほしい作業」を **Job** として投入し、
ローカル環境だけで動くツール（MCP / CLI / Vibe Kanban など）に **inbound port を開けず**に実行してもらうための、
pull 型の control plane + runner です。

## これは Node 製？

はい。現状のコアは **Node.js / TypeScript** です。

- `apps/api`: Control Plane API（Node）
- `apps/runner`: ローカル runner（Node）
- `apps/brain-py`: 追加の “brain runner”（Python / 任意）

## 全体像（ざっくり）

- Source（例: FlowAlign）が `POST /jobs` で Job を作る
- Runner が `GET /jobs/next` で Job を **pull** して実行し、`/events` と `/complete` で結果を返す
- plan job の完了時は、Control Plane が（任意で）webhook を飛ばして Source に反映できる

詳細（Mermaid図つき）:
- `docs/ARCHITECTURE.ja.md`
- FlowAlign 連携: `docs/FLOWALIGN-INTEGRATION.md`（日本語）

## Repo Layout

- `apps/api`: control plane API（jobs / lease / logs / plan approval）
- `apps/runner`: runner（CLI/MCP/Vibe Kanban/AI backend 実行）
- `apps/brain-py`: Python brain runner（`kind=brain` の plan 生成）
- `apps/web`: Web UI（将来用 / まだ薄い。現状は `apps/api` が `/ui` に簡易 Dev UI を同梱）
- `packages/shared`: JobSpec/Result の型（TS）
- `docs/`: 概念・連携仕様

## Status

Skeleton 〜 MVP 途中。ローカル単体テスト用に、API は `/ui` に簡易 Dev UI を同梱。

## Quickstart（dev）

1) deps（初回）
- `vibe-bridge/` で `pnpm install`

2) build
- `pnpm run build`

3) API 起動
- `API_TOKEN=dev PORT=3900 pnpm run start:api`

（`.env` で起動したい場合）
- `cp env.example .env`
- `pnpm run start:api:env`

3.5) Dev UI を開く
- `http://127.0.0.1:3900/ui`（`API_TOKEN=dev` の場合は UI 側の Token に `dev` を入れる）

4) Node runner 起動（CLI/MCP/Vibe Kanban 実行用）
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev VIBE_BRIDGE_WORKSPACE_ROOT=/absolute/path pnpm run start:runner`

（`.env` で起動したい場合）
- `cp env.example .env`
- `pnpm run start:runner:env`

補足（workspace root）:
- `VIBE_BRIDGE_WORKSPACE_ROOT` は runner の作業用ディレクトリです（ログ/生成物/一時ファイル等）。
- 一般には **ユーザー配下の固定ディレクトリ**（例: `~/.vibe-bridge/work`）が無難です。`/tmp` は掃除されることがあるので非推奨です。

5) （任意）Python brain runner 起動（plan 生成用）
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev python3 apps/brain-py/brain_runner.py`

補足:
- brain runner を使う場合、Node runner が `kind=brain` を掴まないように `VIBE_BRIDGE_RUNNER_KINDS` を設定すると安全です（例: `cli,mcp,vibeKanban,vibeKanban.mcp`）。

## AI backend jobs

`kind=ai` の Job は `params.aiBackend` で実行先を切り替えます。

- `codex-cli`: Codex CLI の `codex exec` を実行
- `codex-app-server`: ローカル Codex app-server daemon を起動/利用して `codex exec --remote ...` を実行
- `local-llm`: OpenAI-compatible `/chat/completions` を実行
- `cursor-cli`: runner 側の `VIBE_BRIDGE_CURSOR_COMMAND` テンプレートで実行
- `command`: runner 側の `VIBE_BRIDGE_AI_COMMAND` テンプレートで任意のローカル agent を実行

入力は `params.prompt` または `job.context` に置きます。`phase=plan` の出力は `artifactsInline.plan`、`phase=execute` の出力は `artifactsInline.response` に入ります。
