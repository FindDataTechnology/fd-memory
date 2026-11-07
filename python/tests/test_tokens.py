"""身份解析（task 1.3）：环境变量 → 凭据文件；权限过宽告警但不静默使用；缺令牌时明确报错。"""

import json
import os
import stat

import pytest

from yongyi_agent.tokens import DEFAULT_URL, default_credentials_path, load_bindings, make_observer, resolve_identity


def write_creds(path, bindings, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "bindings": bindings}), encoding="utf-8")
    os.chmod(path, mode)
    return path


def test_explicit_token_wins(tmp_path):
    resolved_url, credential = resolve_identity("langchain", url="http://x:1", token="explicit", env={})
    assert (resolved_url, credential) == ("http://x:1", "explicit")


def test_env_token_and_url(tmp_path):
    env = {"YONGYI_TOKEN": "env-token", "YONGYI_URL": "http://env:2"}
    assert resolve_identity("crewai", env=env) == ("http://env:2", "env-token")


def test_legacy_env_name_still_works():
    assert resolve_identity("crewai", env={"FD_MEMORY_TOKEN": "legacy"})[1] == "legacy"


def test_default_url_when_nothing_set():
    assert resolve_identity("x", token="t", env={})[0] == DEFAULT_URL


def test_credentials_file_binding_for_this_harness(tmp_path):
    creds = write_creds(
        tmp_path / "credentials.json",
        {"langchain": {"url": "http://file:3", "token": "file-token", "namespace": "u/a@b"}},
    )
    assert resolve_identity("langchain", env={}, credentials_path=creds) == ("http://file:3", "file-token")


def test_credentials_file_falls_back_to_any_binding(tmp_path):
    creds = write_creds(tmp_path / "c.json", {"claude-code": {"url": "http://cc:4", "token": "cc-token"}})
    # 同一个人根跨工具合流：令牌本就通用，退化到任意 binding 是对的
    assert resolve_identity("llamaindex", env={}, credentials_path=creds) == ("http://cc:4", "cc-token")


def test_env_beats_credentials_file(tmp_path):
    creds = write_creds(tmp_path / "c.json", {"langchain": {"url": "http://file:5", "token": "file"}})
    assert resolve_identity("langchain", env={"YONGYI_TOKEN": "env"}, credentials_path=creds)[1] == "env"


def test_missing_token_raises_with_actionable_message(tmp_path):
    with pytest.raises(RuntimeError) as err:
        resolve_identity("langchain", env={}, credentials_path=tmp_path / "absent.json")
    message = str(err.value)
    assert "YONGYI_TOKEN" in message
    assert "yongyi connect" in message


def test_corrupt_credentials_file_is_treated_as_absent(tmp_path):
    path = tmp_path / "c.json"
    path.write_text("{not json", encoding="utf-8")
    assert load_bindings(path, env={}) == {}


def test_loose_permissions_warn_on_stderr(tmp_path, capsys):
    creds = write_creds(tmp_path / "c.json", {"langchain": {"url": "http://f:6", "token": "t"}}, mode=0o644)
    load_bindings(creds, env={})
    err = capsys.readouterr().err
    assert "chmod 600" in err, "宽权限不静默使用——必须告警"


def test_default_credentials_path_honours_yongyi_home(tmp_path):
    path = default_credentials_path({"YONGYI_HOME": str(tmp_path / "yy")})
    assert path == tmp_path / "yy" / "credentials.json"


def test_make_observer_binds_harness(tmp_path):
    observer = make_observer("langchain", url="http://h:7", token="t", synchronous=True)
    assert observer.harness == "langchain"
    assert observer.url == "http://h:7/observe"


def test_creds_file_is_not_written_by_resolution(tmp_path):
    creds = write_creds(tmp_path / "c.json", {"langchain": {"url": "http://f:8", "token": "t"}})
    before = creds.read_text(encoding="utf-8")
    resolve_identity("langchain", env={}, credentials_path=creds)
    assert creds.read_text(encoding="utf-8") == before, "适配层只消费凭据，不铸造、不改写"
    assert stat.S_IMODE(creds.stat().st_mode) == 0o600
