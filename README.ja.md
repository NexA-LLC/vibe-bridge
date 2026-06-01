# Vibe Bridge（日本語）

Vibe Bridge は、クラウド側の workflow から「やってほしい作業」を **Job** として投入し、
ローカル環境だけで動くツール（MCP / CLI / Vibe Kanban / Codex / Cursor / Claude Code / local LLM など）に
**inbound port を開けず**に実行してもらうための、pull 型の control plane + runner です。

実用上は、クラウドアプリ、Slack/LINE、SQS、Webhook などが「この作業をして」と依頼し、
実際の作業は開発者のローカルマシン上の runner が Codex / Cursor / Claude Code / MCP / CLI を使って実行します。

## 何を解くもの？

便利な開発者ツールほど、ローカルの repo、認証済みCLI、エディタ、MCP server、秘密情報に近い場所で動きます。
ただし、そのローカルマシンに inbound port を開けるのは危険です。

Vibe Bridge は runner を pull 型にします。

```text
external source -> control plane job queue <- local runner -> local tools
```

Source は runner に直接接続しません。Runner が outbound HTTPS で Job を lease し、
ローカルで実行して、status / logs / plan / result を control plane に返します。

## 代表的な使い方

- workflow system から Codex / Cursor / Claude Code / local LLM を起動する。
- Slack / LINE / SQS / WebSocket / webhook の入力を plan job に変換する。
- private repo を control plane にアップロードせず、ローカル runner 側で作業する。
- まず plan を作り、人間が確認してから execute job に進める。
- allowlist 済み command や MCP / Vibe Kanban adapter に job を流す。

## これは Node 製？

はい。現状のコアは **Node.js / TypeScript** です。

- `apps/api`: Control Plane API（Node）
- `apps/ingress`: 入力 adapter（Webhook / Slack / LINE / SQS / WebSocket）
- `apps/runner`: ローカル runner（Node）
- `apps/brain-py`: 追加の “brain runner”（Python / 任意）

## 全体像（ざっくり）

- Source（例: FlowAlign）が `POST /jobs` で Job を作る
- Runner が `GET /jobs/next` で Job を **pull** して実行し、`/events` と `/complete` で結果を返す
- plan job の完了時は、Control Plane が（任意で）webhook を飛ばして Source に反映できる

詳細（Mermaid図つき）:
- `docs/ARCHITECTURE.ja.md`
- `docs/INGRESS.md`
- FlowAlign 連携: `docs/FLOWALIGN-INTEGRATION.md`（日本語）
- `SECURITY.md`
- `docs/THREAT_MODEL.md`

## セキュリティ

Vibe Bridge はローカルの開発者ツールを実行できるため、単なる webhook relay ではなく
local execution infrastructure として扱う必要があります。

- 外部入力は原則 `phase=plan` にする。
- `phase=execute` は承認済み、または runner 側で tenant/kind/phase/command を絞った状態で実行する。
- 公開 tunnel/ngrok/Cloudflare Tunnel は ingress process のみに向け、runner は inbound 公開しない。
- 詳細は `SECURITY.md` と `docs/THREAT_MODEL.md` を参照。

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

4) （任意）Ingress 起動（Webhook / Slack / LINE / SQS / WebSocket 入力用）
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev VIBE_BRIDGE_INGRESS_SOURCES=webhook pnpm run start:ingress`

5) Node runner 起動（CLI/MCP/Vibe Kanban 実行用）
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev VIBE_BRIDGE_WORKSPACE_ROOT=/absolute/path pnpm run start:runner`

（`.env` で起動したい場合）
- `cp env.example .env`
- `pnpm run start:runner:env`

補足（workspace root）:
- `VIBE_BRIDGE_WORKSPACE_ROOT` は runner の作業用ディレクトリです（ログ/生成物/一時ファイル等）。
- 一般には **ユーザー配下の固定ディレクトリ**（例: `~/.vibe-bridge/work`）が無難です。`/tmp` は掃除されることがあるので非推奨です。

6) （任意）Python brain runner 起動（plan 生成用）
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev python3 apps/brain-py/brain_runner.py`

補足:
- brain runner を使う場合、Node runner が `kind=brain` を掴まないように `VIBE_BRIDGE_RUNNER_KINDS` を設定すると安全です（例: `cli,mcp,vibeKanban,vibeKanban.mcp`）。

## AI backend jobs

`kind=ai` の Job は `params.aiBackend` で実行先を切り替えます。

- `codex-cli`: Codex CLI の `codex exec` を実行
- `codex-app-server`: ローカル Codex app-server daemon を起動/利用して `codex exec --remote ...` を実行
- `cursor-cli`: Cursor Agent を `--print` で実行（`VIBE_BRIDGE_CURSOR_COMMAND` があればテンプレート実行）
- `cursor-api`: Cursor/OpenAI-compatible な API endpoint を実行
- `claude-code`: Claude Code を `claude --print` で実行
- `local-llm`: OpenAI-compatible `/chat/completions` を実行
- `openai-compatible`: 任意の OpenAI-compatible `/chat/completions` endpoint を実行
- `command`: runner 側の `VIBE_BRIDGE_AI_COMMAND` テンプレートで任意のローカル agent を実行

入力は `params.prompt` または `job.context` に置きます。`phase=plan` の出力は `artifactsInline.plan`、`phase=execute` の出力は `artifactsInline.response` に入ります。

## Job を作る例

API 起動後、次のように plan job を作れます。

```bash
curl -sS http://127.0.0.1:3900/jobs \
  -H 'Authorization: Bearer dev' \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId": "default",
    "kind": "ai",
    "phase": "plan",
    "context": "Inspect this repository and propose a safe README improvement.",
    "params": {
      "prompt": "Inspect this repository and propose a safe README improvement.",
      "aiBackend": "codex-cli"
    }
  }'
```

runner は plan job に絞って起動します。

```bash
VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 \
VIBE_BRIDGE_API_TOKEN=dev \
VIBE_BRIDGE_WORKSPACE_ROOT=~/.vibe-bridge/work \
VIBE_BRIDGE_RUNNER_PHASES=plan \
pnpm run start:runner
```

`http://127.0.0.1:3900/ui` で job、runner event、plan output を確認できます。

## demo 時の安全な初期設定

- 外部入力は `phase=plan` にする。
- ngrok / Cloudflare Tunnel は `apps/ingress` のみに向ける。
- generic webhook には `VIBE_BRIDGE_INGRESS_TOKEN` を設定する。
- Slack / LINE は signing secret を設定してから有効化する。
- command 実行を使う前に `VIBE_BRIDGE_COMMANDS_STRICT=1` を設定する。
- runner は `VIBE_BRIDGE_RUNNER_TENANT_ID`、`VIBE_BRIDGE_RUNNER_KINDS`、`VIBE_BRIDGE_RUNNER_PHASES` で絞る。
