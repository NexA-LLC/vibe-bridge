#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _normalize_base_url(value: str) -> str:
    return value.strip().rstrip("/")


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    raw = os.environ.get(name)
    if raw is None:
        return default
    trimmed = raw.strip()
    return trimmed if trimmed else default


def _http_json(
    method: str,
    url: str,
    token: Optional[str],
    payload: Optional[Dict[str, Any]] = None,
    timeout_sec: float = 30,
) -> Tuple[int, Optional[Dict[str, Any]]]:
    data = None
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as res:
            status = int(getattr(res, "status", 0) or 0)
            raw = res.read().decode("utf-8", errors="replace")
            if not raw.strip():
                return status, None
            try:
                return status, json.loads(raw)
            except json.JSONDecodeError:
                return status, None
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {e.reason}: {raw}") from e


@dataclass(frozen=True)
class ControlPlaneConfig:
    api_base: str
    api_token: Optional[str]
    poll_interval_sec: float
    lease_ttl_sec: int
    wait_sec: int


@dataclass(frozen=True)
class LlmConfig:
    base_url: str
    api_key: str
    model: str
    timeout_sec: int


def _load_control_plane_config(args: argparse.Namespace) -> ControlPlaneConfig:
    api_base = _env("VIBE_BRIDGE_API_BASE")
    if not api_base:
        raise RuntimeError("Missing VIBE_BRIDGE_API_BASE (e.g. http://127.0.0.1:3900)")
    api_token = _env("VIBE_BRIDGE_API_TOKEN")
    return ControlPlaneConfig(
        api_base=_normalize_base_url(api_base),
        api_token=api_token,
        poll_interval_sec=float(args.poll_interval_sec),
        lease_ttl_sec=int(args.lease_ttl_sec),
        wait_sec=int(args.wait_sec),
    )


def _load_llm_config() -> LlmConfig:
    base_url = _env("VIBE_BRIDGE_LLM_BASE_URL", "http://127.0.0.1:1234/v1") or ""
    api_key = _env("VIBE_BRIDGE_LLM_API_KEY", "sk-local") or ""
    model = _env("VIBE_BRIDGE_LLM_MODEL", "auto") or ""
    timeout_sec = 20
    timeout_ms_raw = _env("VIBE_BRIDGE_LLM_TIMEOUT_MS")
    timeout_sec_raw = _env("VIBE_BRIDGE_LLM_TIMEOUT_SEC")
    if timeout_ms_raw:
        try:
            ms = int(timeout_ms_raw)
            timeout_sec = max(1, (ms + 999) // 1000)
        except ValueError:
            timeout_sec = 20
    elif timeout_sec_raw:
        try:
            timeout_sec = int(timeout_sec_raw)
        except ValueError:
            timeout_sec = 20
    return LlmConfig(
        base_url=_normalize_base_url(base_url),
        api_key=api_key,
        model=model,
        timeout_sec=max(1, timeout_sec),
    )


def _read_plan_prompt_template() -> str:
    # vibe-bridge/apps/brain-py/brain_runner.py -> repo root is parents[2]
    repo_root = Path(__file__).resolve().parents[2]
    prompt_path = repo_root / "prompts" / "plan.md"
    return prompt_path.read_text(encoding="utf-8")


def _render_plan_prompt(template: str, *, task_context: str, repo_context: str, constraints: str) -> str:
    return (
        template.replace("{{TASK_CONTEXT}}", task_context)
        .replace("{{REPO_CONTEXT}}", repo_context)
        .replace("{{CONSTRAINTS}}", constraints)
    )


def _build_repo_context(job: Dict[str, Any]) -> str:
    lines: List[str] = []
    repo = job.get("repo")
    if isinstance(repo, dict):
        url = str(repo.get("url") or "").strip()
        ref = str(repo.get("ref") or "").strip()
        subdir = str(repo.get("subdir") or "").strip()
        if url:
            lines.append(f"- repo.url: {url}")
            if ref:
                lines.append(f"- repo.ref: {ref}")
            if subdir:
                lines.append(f"- repo.subdir: {subdir}")
    commands = job.get("commands")
    if isinstance(commands, dict):
        plan_cmd = str(commands.get("plan") or "").strip()
        exec_cmd = str(commands.get("execute") or "").strip()
        if plan_cmd:
            lines.append(f"- commands.plan: {plan_cmd}")
        if exec_cmd:
            lines.append(f"- commands.execute: {exec_cmd}")
    plan_output_path = str(job.get("planOutputPath") or "").strip()
    if plan_output_path:
        lines.append(f"- planOutputPath: {plan_output_path}")

    return "\n".join(lines) if lines else "(none)"


def _build_constraints(job: Dict[str, Any]) -> str:
    params = job.get("params")
    if not isinstance(params, dict):
        return ""
    for key in ["constraints", "constraint", "flowalignConstraints"]:
        value = params.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _request_chat_completion(llm: LlmConfig, messages: List[Dict[str, str]], temperature: float = 0.2) -> str:
    url = f"{llm.base_url}/chat/completions"
    payload: Dict[str, Any] = {
        "model": llm.model,
        "messages": messages,
        "temperature": temperature,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {llm.api_key}",
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=llm.timeout_sec) as res:
            raw = res.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LLM HTTP {e.code} {e.reason}: {raw}") from e
    except Exception as e:
        raise RuntimeError(f"LLM request failed: {e}") from e

    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            msg = first.get("message")
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    return content
    raise RuntimeError("Empty LLM response")


def _post_event(cfg: ControlPlaneConfig, job_id: str, kind: str, message: str) -> None:
    url = f"{cfg.api_base}/jobs/{urllib.parse.quote(job_id)}/events"
    _http_json(
        "POST",
        url,
        cfg.api_token,
        payload={"event": {"kind": kind, "message": message}},
        timeout_sec=30,
    )


def _complete_job(cfg: ControlPlaneConfig, result: Dict[str, Any]) -> None:
    job_id = str(result.get("jobId") or "").strip()
    if not job_id:
        raise RuntimeError("Missing jobId in result")
    url = f"{cfg.api_base}/jobs/{urllib.parse.quote(job_id)}/complete"
    _http_json("POST", url, cfg.api_token, payload={"result": result}, timeout_sec=30)


def _lease_next_job(cfg: ControlPlaneConfig) -> Optional[Dict[str, Any]]:
    query = urllib.parse.urlencode(
        {
            "waitSec": str(cfg.wait_sec),
            "leaseTtlSec": str(cfg.lease_ttl_sec),
            "kinds": "brain",
            "phases": "plan",
        }
    )
    url = f"{cfg.api_base}/jobs/next?{query}"
    status, data = _http_json("GET", url, cfg.api_token, payload=None, timeout_sec=max(1, cfg.wait_sec + 5))
    if status == 204 or data is None:
        return None
    job = data.get("job") if isinstance(data, dict) else None
    return job if isinstance(job, dict) else None


def _handle_job(cfg: ControlPlaneConfig, llm: LlmConfig, template: str, job: Dict[str, Any]) -> None:
    job_id = str(job.get("id") or "").strip()
    if not job_id:
        return

    started_ts = time.time()
    try:
        _post_event(cfg, job_id, "status", "Started plan (brain)")

        task_context = str(job.get("context") or "").strip()
        repo_context = _build_repo_context(job)
        constraints = _build_constraints(job)

        prompt = _render_plan_prompt(
            template,
            task_context=task_context,
            repo_context=repo_context,
            constraints=constraints,
        )

        messages = [
            {
                "role": "system",
                "content": "You are a planning assistant. Follow the user's instructions exactly.",
            },
            {"role": "user", "content": prompt},
        ]

        plan_text = _request_chat_completion(llm, messages, temperature=0.2)
        _post_event(cfg, job_id, "status", "Plan generated")

        _complete_job(
            cfg,
            {
                "jobId": job_id,
                "status": "completed",
                "finishedAt": _now_iso(),
                "artifactsInline": {"plan": plan_text},
            },
        )
    except Exception as e:
        err = str(e)
        try:
            _post_event(cfg, job_id, "status", f"Plan failed: {err}")
        except Exception:
            pass
        _complete_job(
            cfg,
            {
                "jobId": job_id,
                "status": "failed",
                "finishedAt": _now_iso(),
                "errorMessage": err,
                "artifactsInline": {},
            },
        )
    finally:
        duration = max(0.0, time.time() - started_ts)
        sys.stdout.write(f"[brain] job {job_id} done ({duration:.1f}s)\n")
        sys.stdout.flush()


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="Vibe Bridge brain runner (plan jobs)")
    parser.add_argument("--poll-interval-sec", default="3", help="Sleep seconds when no job is available")
    parser.add_argument("--lease-ttl-sec", default="300", help="Lease TTL seconds for /jobs/next")
    parser.add_argument("--wait-sec", default="0", help="Long-poll seconds for /jobs/next")
    args = parser.parse_args(argv)

    cfg = _load_control_plane_config(args)
    llm = _load_llm_config()
    template = _read_plan_prompt_template()

    sys.stdout.write("[brain] runner started\n")
    sys.stdout.flush()

    while True:
        try:
            job = _lease_next_job(cfg)
            if job is None:
                time.sleep(cfg.poll_interval_sec)
                continue
            _handle_job(cfg, llm, template, job)
        except KeyboardInterrupt:
            return 0
        except Exception as e:
            sys.stderr.write(f"[brain] error: {e}\n")
            sys.stderr.flush()
            time.sleep(cfg.poll_interval_sec)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
