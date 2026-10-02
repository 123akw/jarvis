"""cryptography 大版本升级回归：旧版本加密落盘的 Provider Key 必须能被当前版本解开。

tests/fixtures/provider_secrets_crypto45/ 是用 cryptography 45.0.7 通过 SecretStore 真实写出的
托管配置（manifest + 两代密文，含一把用户 LLM Key 和一把 Tavily Key），meta.json 记录生成时
的版本、仅测试用的主密钥与期望明文，另附一组 AES-GCM 原语向量。升级 cryptography 后这里
变红，就说明线上已存的 Key 会在升级后读不出来（ManagedConfigUnavailable → 设置页只读）。
"""
import base64
import json
import shutil
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from jarvis.provider_settings import ManagedConfigUnavailable, SecretStore

FIXTURE = Path(__file__).parent / "fixtures" / "provider_secrets_crypto45"
META = json.loads((FIXTURE / "meta.json").read_text(encoding="utf-8"))


def _b64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value)


@pytest.fixture
def legacy_dir(tmp_path):
    """复制一份旧密文：SecretStore 会建锁文件、改权限，不能动仓库里的样本。"""
    target = tmp_path / "data"
    shutil.copytree(FIXTURE, target)
    (target / "meta.json").unlink()
    return target


def test_fixture_really_comes_from_the_old_version():
    assert META["generated_with"]["cryptography"] == "45.0.7"


def test_aesgcm_vector_from_old_version_decrypts():
    vector = META["aesgcm_vector"]
    plain = AESGCM(_b64(META["master_key"])).decrypt(
        _b64(vector["nonce"]), _b64(vector["ciphertext"]), _b64(vector["aad"]))
    assert plain == _b64(vector["plaintext"])


def test_provider_keys_sealed_by_old_version_still_resolve(legacy_dir):
    store = SecretStore(legacy_dir, master_key=META["master_key"], write_enabled=True)
    llm = store.resolved_llm(META["owner"])
    expected = META["expected"]
    assert (llm.source, llm.provider, llm.model) == ("managed", expected["llm_provider"], expected["llm_model"])
    assert llm.api_key == expected["llm_api_key"]
    assert store.integration_values()["tavily"]["api_key"] == expected["tavily_api_key"]


def test_previous_generation_from_old_version_is_still_a_valid_fallback(legacy_dir):
    """active 代损坏时回退 previous 代——这一代同样是旧版本写的，也必须能解开。"""
    manifest = json.loads((legacy_dir / "provider-active.json").read_text())
    (legacy_dir / "provider-generations" / f"{manifest['active_generation']}.enc").write_bytes(b"damaged")
    store = SecretStore(legacy_dir, master_key=META["master_key"])
    assert store.resolved_llm(META["owner"]).api_key == META["expected"]["llm_api_key"]


def test_keep_existing_key_reseals_old_secret_with_current_version(legacy_dir):
    """升级后第一次保存设置（不重填 Key）：旧密文被解开并用新版本重新封装，读回一致。"""
    store = SecretStore(legacy_dir, master_key=META["master_key"], write_enabled=True)
    current = store.resolved_llm(META["owner"])
    saved = store.commit_llm(
        META["owner"],
        {"provider": current.provider, "base_url": current.base_url, "model": "deepseek-next", "api_key": ""},
        expected_generation=current.generation, keep_existing_key=True,
    )
    assert saved.api_key == META["expected"]["llm_api_key"]
    reread = SecretStore(legacy_dir, master_key=META["master_key"]).resolved_llm(META["owner"])
    assert (reread.model, reread.api_key) == ("deepseek-next", META["expected"]["llm_api_key"])


def test_old_ciphertext_with_wrong_master_key_still_fails_closed(legacy_dir):
    wrong = base64.urlsafe_b64encode(b"W" * 32).decode()
    with pytest.raises(ManagedConfigUnavailable):
        SecretStore(legacy_dir, master_key=wrong).resolved_llm(META["owner"])
