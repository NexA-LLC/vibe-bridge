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
- `apps/runner`: runner（CLI/MCP/Vibe Kanban 実行）
- `apps/brain-py`: Python brain runner（`kind=brain` の plan 生成）
- `apps/web`: Web UI（将来用 / まだ薄い）
- `packages/shared`: JobSpec/Result の型（TS）
- `docs/`: 概念・連携仕様

## Status

Skeleton 〜 MVP 途中。UI は後回しで、まずは FlowAlign など既存の UI から Job を投入して回す。

## Quickstart（dev）

1) deps（初回）
- `vibe-bridge/` で `npm` / `pnpm` などいつものワークスペースツールで依存を入れる

2) build
- `npm -C vibe-bridge run build`

3) API 起動
- `API_TOKEN=dev PORT=3900 npm -C vibe-bridge run start:api`

4) Node runner 起動（CLI/MCP/Vibe Kanban 実行用）
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev VIBE_BRIDGE_WORKSPACE_ROOT=/absolute/path npm -C vibe-bridge run start:runner`

5) （任意）Python brain runner 起動（plan 生成用）
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev python3 vibe-bridge/apps/brain-py/brain_runner.py`

補足:
- brain runner を使う場合、Node runner が `kind=brain` を掴まないように `VIBE_BRIDGE_RUNNER_KINDS` を設定すると安全です（例: `cli,mcp,vibeKanban,vibeKanban.mcp`）。

