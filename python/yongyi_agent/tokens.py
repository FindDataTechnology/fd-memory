# ── 身份解析：令牌从哪来 ─────────────────────────────────────────────────────
#
# 与 `yongyi connect` 写出的凭据文件同构：令牌权威是永忆的 token 树，本包只
# 消费，不铸造（铸造留在 CLI / 服务端 --as 流程，避免适配层多一条写凭据的路）。
#
# 查找顺序（先显式、后隐式）：
#   1. 显式参数
#   2. 环境变量 YONGYI_TOKEN / FD_MEMORY_TOKEN
#   3. 凭据文件 ~/.yongyi/credentials.json 的某个 binding
#
# 权限检查：凭据文件必须是 0600（或更严）。宽权限不静默使用——给告警，因为
# 那意味着令牌可能已被同机其它用户读到。

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import Dict, Mapping, Optional, Tuple

DEFAULT_URL = "http://127.0.0.1:49375"


def default_credentials_path(env: Optional[Mapping[str, str]] = None) -> Path:
    env = env if env is not None else os.environ
    home = env.get("YONGYI_HOME") or os.path.join(os.path.expanduser("~"), ".yongyi")
    return Path(home) / "credentials.json"


def _warn(message: str) -> None:
    print("[yongyi] " + message, file=sys.stderr)


def _check_mode(path: Path) -> None:
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        return
    if mode & 0o077:
        _warn(
            "%s 权限为 %o，令牌可能已被同机其它用户读取；建议 chmod 600"
            % (str(path), mode)
        )


def load_bindings(
    credentials_path: Optional[Path] = None, env: Optional[Mapping[str, str]] = None
) -> Dict[str, Dict[str, object]]:
    """读凭据文件里的 bindings（读不到就当空，不抛）。"""
    path = credentials_path or default_credentials_path(env)
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    bindings = doc.get("bindings") if isinstance(doc, dict) else None
    if not isinstance(bindings, dict):
        return {}
    _check_mode(Path(path))
    return {str(k): v for k, v in bindings.items() if isinstance(v, dict)}


def resolve_identity(
    harness: str = "python",
    *,
    url: Optional[str] = None,
    token: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    credentials_path: Optional[Path] = None,
) -> Tuple[str, str]:
    """返回 (url, token)。

    令牌来源按「显式 → 环境变量 → 凭据文件」查找；凭据文件里优先取本框架的
    binding，其次取任意一个（一个人根跨工具合流，令牌本就通用）。
    找不到令牌时抛 RuntimeError——这是配置缺失，必须让用户看见。
    """
    env = env if env is not None else os.environ
    resolved_url = url or env.get("YONGYI_URL") or DEFAULT_URL

    if token:
        return resolved_url, token

    for name in ("YONGYI_TOKEN", "FD_MEMORY_TOKEN"):
        value = env.get(name)
        if value:
            return resolved_url, value

    bindings = load_bindings(credentials_path, env)
    chosen = bindings.get(harness) or (next(iter(bindings.values())) if bindings else None)
    if chosen:
        bound_token = chosen.get("token")
        if bound_token:
            return str(chosen.get("url") or resolved_url), str(bound_token)

    raise RuntimeError(
        "no yongyi token found — set YONGYI_TOKEN, or run `yongyi connect <harness> --as <user>` "
        "to write %s" % str(default_credentials_path(env))
    )


def make_observer(harness: str = "python", **kwargs):  # type: ignore[no-untyped-def]
    """按解析出的身份造一个 Observer（最常用的入口）。"""
    from .observe import Observer

    resolved_url, credential = resolve_identity(
        harness, **{k: kwargs.pop(k) for k in ("url", "token", "env", "credentials_path") if k in kwargs}
    )
    return Observer(resolved_url, credential, harness=harness, **kwargs)
